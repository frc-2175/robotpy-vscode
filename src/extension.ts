import assert from "assert";
import { ChildProcessWithoutNullStreams, exec, execFile, spawn, SpawnOptions } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";

const execAsync = promisify(exec);

let outputChannel: vscode.OutputChannel;
let robotpyTerminalAndEmitter: [vscode.Terminal, vscode.EventEmitter<string>] | undefined;
let currentProcess: { proc: ChildProcessWithoutNullStreams, cmdString: string, prettyName: string } | undefined;

const VENV_DIR = '.venv';
const PYTHON_MIN_VERSION = [3, 12];

const TERMINAL_NAME = 'RobotPy';
const OUTPUT_CHANNEL_NAME = 'RobotPy';
const ROBOTPY_DOCS_URL = "https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-2/python-setup.html";

let resolveExtensionInitialized: () => void;
const extensionInitialized = new Promise<void>(res => { resolveExtensionInitialized = res; });

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

    // Register commands.
    context.subscriptions.push(
        vscode.commands.registerCommand('robotpy.init', () => robotpyCommands(["init"])),
        vscode.commands.registerCommand('robotpy.sync', () => robotpyCommands(["project", "update-robotpy"], ["sync"])),
        vscode.commands.registerCommand('robotpy.sim', () => robotpyCommands(["sim"])),
        vscode.commands.registerCommand('robotpy.deploy', () => robotpyCommands(["deploy"])),
        vscode.commands.registerCommand('robotpy.deploySkipTests', () => robotpyCommands(["deploy", "--skip-tests"])),
    );

    // TODO: Register sim as a task of some kind?

    onProjectOpen().finally(resolveExtensionInitialized);
}

export function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
}

function isWindows(): boolean {
    return os.platform() === 'win32';
}

function getVenvPath(rootPath: string): string {
    return path.join(rootPath, VENV_DIR);
}

function getVenvPythonPath(rootPath: string): string {
    return isWindows()
        ? path.join(getVenvPath(rootPath), "Scripts", "python.exe")
        : path.join(getVenvPath(rootPath), "bin", "python");
}

function getVenvPipPath(rootPath: string): string {
    return isWindows()
        ? path.join(getVenvPath(rootPath), "Scripts", "pip.exe")
        : path.join(getVenvPath(rootPath), "bin", "pip");
}

interface PythonCommand {
    /** The command to run to invoke Python. */
    cmd: string,
    args: string[],
    /** The Python major/minor version numbers. */
    version: [number, number],
    /** The Python major.minor version as a string. */
    versionStr: string,
}

async function findPythonCommand(venvPath?: string): Promise<PythonCommand | null> {
    let candidates = [["python.exe"], ["python3"], ["python"], ["py", "-3"], ["py"]];
    if (venvPath) {
        candidates = [
            ...candidates.map(c => [path.join(venvPath, "bin", c[0]), ...c.slice(1)]),
            ...candidates.map(c => [path.join(venvPath, "Scripts", c[0]), ...c.slice(1)]),
        ];
    }
    for (const candidate of candidates) {
        try {
            const executable = candidate[0];
            const args = candidate.slice(1);

            const { stdout, stderr } = await execFancy(executable, [...args, "--version"], { silent: true });
            const out = stdout || stderr; // python may print version to stderr, says my LLM

            const match = out.match(/Python\s+(\d+)\.(\d+)/i);
            if (!match) continue;

            const major = parseInt(match[1], 10);
            const minor = parseInt(match[2], 10);

            return {
                cmd: executable,
                args: args,
                version: [major, minor],
                versionStr: `${major}.${minor}`,
            };
        } catch (e) {
            outputChannel.appendLine(`Python candidate ${candidate} did not work: ${e}`);
        }
    }

    return null;
}

interface EnvironmentChecks {
    /** Does this project have a RobotPy pyproject.toml file? */
    hasRobotPyProjectFile: boolean,

    /** Is Python installed at all? */
    hasSystemPython: boolean,
    /** Do we have a recent enough version of system Python? */
    isSystemPythonNewEnough: boolean,
    /** Does the system Python have the "venv" module? */
    hasSystemPythonVenvModule: boolean,
    systemPythonCommand: PythonCommand | null,

    /** Have we created the venv? */
    hasVenvFolder: boolean,
    /** Does the venv contain a recent enough version of Python? */
    isVenvPythonNewEnough: boolean,
    /** Does the venv contain a working version of RobotPy? */
    isVenvReady: boolean,
    venvPythonCommand: PythonCommand | null,

    /** On Windows, does Powershell allow us to execute scripts? (Thank you Microsoft.) */
    winExecutionPolicyOk: boolean,
}

async function checkEnvironment(rootPath: string): Promise<[EnvironmentChecks, boolean]> {
    const result: EnvironmentChecks = {
        hasRobotPyProjectFile: false,

        hasSystemPython: false, // Is python installed at all?
        isSystemPythonNewEnough: false, // Do we have a recent enough version of system Python?
        hasSystemPythonVenvModule: false, // Does the system python have the "venv" module?
        systemPythonCommand: null,

        hasVenvFolder: false, // Have we created the venv?
        isVenvPythonNewEnough: false, // Does the venv contain a recent enough version of Python?
        isVenvReady: false, // Does the venv contain a working version of RobotPy?
        venvPythonCommand: null,

        winExecutionPolicyOk: isWindows() ? false : true, // On Windows, does Powershell allow us to execute scripts? (Thank you Microsoft.)
    };
    let didError = false;

    // Check if there is a RobotPy project
    outputChannel.appendLine("Checking for a RobotPy project...");
    try {
        const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(rootPath, 'pyproject.toml')));
        const content = Buffer.from(fileContent).toString('utf8');
        if (content.includes('[tool.robotpy]')) {
            result.hasRobotPyProjectFile = true;
        }
    } catch (e) {
        outputChannel.appendLine(`Expected (?) error when checking for pyproject.toml: ${e}`);
    }

    // Check status of system Python
    outputChannel.appendLine("Checking system Python...");
    const systemPython = await findPythonCommand();
    if (systemPython) {
        result.hasSystemPython = true;
        result.systemPythonCommand = systemPython;
        outputChannel.appendLine(`System Python found with version ${systemPython.versionStr}`);

        if (systemPython.version[0] >= PYTHON_MIN_VERSION[0] && systemPython.version[1] >= PYTHON_MIN_VERSION[1]) {
            result.isSystemPythonNewEnough = true;
            outputChannel.appendLine("System Python is new enough");

            try {
                await execFancy(systemPython.cmd, [...systemPython.args, "-c", "import venv"], { silent: true });
                result.hasSystemPythonVenvModule = true;
                outputChannel.appendLine("System Python has venv module");
            } catch (e) {
                // Empty catch should be ok here because we just verified that
                // the given Python command works. But for sanity, we still log
                // whatever happens here.
                outputChannel.appendLine(`Expected (?) error when checking for system venv module: ${e}`);
            }
        } else {
            outputChannel.appendLine("System Python is too old");
        }
    }

    // Check status of venv
    if (fs.existsSync(getVenvPath(rootPath))) {
        result.hasVenvFolder = true;
        outputChannel.appendLine(`venv found at ${getVenvPath(rootPath)}`);

        const venvPython = await findPythonCommand(getVenvPath(rootPath));
        if (venvPython) {
            result.venvPythonCommand = venvPython
            outputChannel.appendLine(`venv Python found with version ${venvPython.versionStr}`);

            if (venvPython.version[0] >= PYTHON_MIN_VERSION[0] && venvPython.version[1] >= PYTHON_MIN_VERSION[1]) {
                result.isVenvPythonNewEnough = true;
                outputChannel.appendLine("venv Python is new enough");

                try {
                    await execFancy(venvPython.cmd, [...venvPython.args, "-c", "import robotpy"], {
                        cwd: rootPath,
                        silent: true,
                    });
                    result.isVenvReady = true;
                    outputChannel.appendLine("venv Python has robotpy and is therefore good to go");
                } catch (e) {
                    outputChannel.appendLine(`Expected (?) error when checking for robotpy in venv: ${e}`);
                }
            } else {
                outputChannel.appendLine("venv Python too old");
            }
        } else {
            outputChannel.appendLine("Python not found in venv");
        }
    }

    if (isWindows()) {
        // Check PowerShell execution policy (thank you Microsoft)
        try {
            const { stdout, stderr } = await execAsync(`powershell -NoProfile -NonInteractive -Command "Get-ExecutionPolicy"`);
            const policy = (stdout || stderr).trim().toLowerCase();
            if (["remotesigned", "bypass", "unrestricted"].includes(policy)) {
                result.winExecutionPolicyOk = true;
            }
        } catch (e) {
            outputChannel.appendLine(`ERROR: Failed to check PowerShell execution policy: ${e}`);
            didError = true;
        }
    }

    // Ensure a few invariants about the checks for sanity.
    if (result.isSystemPythonNewEnough) {
        assert.ok(result.hasSystemPython);
    }
    if (result.hasSystemPythonVenvModule) {
        assert.ok(result.hasSystemPython && result.isSystemPythonNewEnough);
    }
    if (result.isVenvPythonNewEnough) {
        assert.ok(result.hasVenvFolder);
    }
    if (result.isVenvReady) {
        assert.ok(result.hasVenvFolder && result.isVenvPythonNewEnough);
    }

    return [result, didError] as const;
}

async function promptUserToKillCurrentProcess() {
    if (!currentProcess) {
        outputChannel.appendLine("WARNING: No process was running when the user was prompted to kill it. Assuming they did want to kill it, in hopes of continuing with whatever logic was running.");
        return true;
    }

    return await new Promise<boolean>(res => {
        let desc = "A command";
        if (currentProcess) {
            desc = `The command "${currentProcess?.prettyName ?? currentProcess?.cmdString}"`;
        }
        vscode.window.showWarningMessage(`${desc} is currently running. Would you like to cancel it?`, "Yes", "No")
            .then(action => res(action === "Yes"));
    });
}

function killCurrentProcess() {
    currentProcess?.proc.kill();
    currentProcess = undefined;
}

/**
 * Gets a PTY and write event emitter for RobotPy commands. We do this in order
 * to present a terminal-like experience for students while still running
 * processes without a shell, since this is a nightmare of quoting and
 * escaping. The PTY has some simple line editing capabilities in order to
 * handle small prompts that appear throughout the course of RobotPy commands.
 */
function getRobotPyTerminal(): [vscode.Terminal, vscode.EventEmitter<string>] {
    if (robotpyTerminalAndEmitter && vscode.window.terminals.includes(robotpyTerminalAndEmitter[0])) {
        return robotpyTerminalAndEmitter;
    }

    let inputBuffer = "";

    const writeEmitter = new vscode.EventEmitter<string>();
    const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        open() {},
        close() {
            killCurrentProcess();
        },
        handleInput(data) {
            if (data.trim().match(/(Scripts|bin)[/\\]activate(\.(bat|ps1))?$/)) {
                // The Python extension tries to activate a venv in our pty.
                // This is obnoxious and we do not want it.
                inputBuffer = "";
                return;
            }

            if (data === "\x03") {
                // ctrl-c
                writeEmitter.fire("^C\r\n");
                killCurrentProcess();
                inputBuffer = "";
            } else if (data === "\r" || data === "\n") {
                // enter
                writeEmitter.fire("\r\n");
                currentProcess?.proc.stdin.write(inputBuffer + "\n");
                inputBuffer = "";
            } else if (data === "\x08" || data === "\x7f") {
                // backspace
                if (inputBuffer.length > 0) {
                    inputBuffer = inputBuffer.slice(0, -1);
                    writeEmitter.fire("\x08 \x08"); // back, space, back
                }
            } else {
                inputBuffer += data;
                writeEmitter.fire(data);
            }
        },
    };

    robotpyTerminalAndEmitter = [
        vscode.window.createTerminal({
            name: TERMINAL_NAME,
            pty,
        }),
        writeEmitter,
    ];
    return robotpyTerminalAndEmitter;
}

interface ExecFancyOptions extends Omit<SpawnOptions, "stdio"> {
    showTerminal?: boolean,
    silent?: boolean,
    prettyName?: string,
}

async function execFancy(cmd: string, args: readonly string[], opts: ExecFancyOptions = {}): Promise<{
    stdout: string,
    stderr: string,
}> {
    // Get the terminal in which we will present this command
    const [terminal, writeEmitter] = getRobotPyTerminal();
    function maybeWriteToTerminal(str: string) {
        if (!opts.silent) {
            writeEmitter.fire(str.replace(/(?<!\r)\n/g, "\r\n"));
        }
    }

    const cmdString = `${cmd} ${args ? args.join(" ") : ""}`.trim();
    const prettyName = opts.prettyName ?? cmdString;

    // Possibly kill the current process
    if (currentProcess) {
        const nope = new Error(`Could not run command because another process (${currentProcess.prettyName ?? currentProcess.cmdString}) was running: ${cmdString}`);
        if (opts.silent) {
            throw nope;
        }

        const killCurrent = await promptUserToKillCurrentProcess();
        if (killCurrent) {
            outputChannel.appendLine(`Process "${currentProcess.cmdString}" killed in order to run: ${cmdString}`);
            killCurrentProcess();
            maybeWriteToTerminal("\r\nProcess killed\r\n");
        } else {
            throw nope;
        }
    }

    outputChannel.appendLine(`Running: ${cmdString}`);
    maybeWriteToTerminal(`$ ${cmdString}\r\n`);
    if (opts.showTerminal) {
        terminal.show();
    }

    let stdout = "", stderr = "";
    await new Promise<void>((res, rej) => {
        const proc = spawn(cmd, args, { ...opts, stdio: "pipe" });
        currentProcess = { proc, cmdString, prettyName };
        proc.stdout.on("data", data => {
            stdout += data.toString();
            outputChannel.append(data.toString());
            maybeWriteToTerminal(data.toString());
        });
        proc.stderr.on("data", data => {
            stderr += data.toString();
            outputChannel.append(data.toString());
            maybeWriteToTerminal(data.toString());
        });
        proc.on("close", (code, signal) => {
            const msg = code === null ? `Process was killed with signal ${signal}` : `Process exited with code ${code}`;
            outputChannel.appendLine(`${msg}: ${cmdString}`);
            maybeWriteToTerminal(`\r\n${msg}\r\n`);
            currentProcess = undefined;
            if (code != 0) {
                rej(new Error(`${msg}: ${prettyName}`));
            } else {
                res();
            }
        });
        proc.on("error", err => {
            currentProcess = undefined;
            rej(err);
        });
    });

    return { stdout, stderr };
}

/**
 * Ensure that a venv is created with a new enough version of Python and
 * robotpy installed, and that the project has been configured to use the venv.
 * Does NOT run `robotpy sync`.
 *
 * Returns false if the venv was not created. This is NOT always an error; for
 * example, the user may decide not to replace the existing venv if it is out
 * of date.
 */
async function ensureVenv(rootPath: string, checks: EnvironmentChecks): Promise<boolean> {
    if (!checks.winExecutionPolicyOk) {
        vscode.window.showWarningMessage("Your system's PowerShell execution policy is incompatible with Python virtual environments. See the output log for details.");
        outputChannel.appendLine("Your PowerShell execution policy does not allow scripts to execute, which will prevent VS Code from activating Python virtual environments. To fix this, do the following:");
        outputChannel.appendLine(" 1. Open a PowerShell window as Administrator.");
        outputChannel.appendLine(" 2. Run the following command: Set-ExecutionPolicy RemoteSigned")
        // We can continue on from this since PowerShell should not actually be
        // required for extension functionality - but it will cause angry
        // errors if students ever open a terminal, so we still want to fix
        // this.
    }

    // Early exit.
    if (checks.isVenvReady) {
        return true;
    }

    function checkSystemPython(): boolean {
        if (!checks.hasSystemPython) {
            vscode.window.showErrorMessage("Cannot install RobotPy: Python is not installed on your system.", "Visit Docs")
                .then(action => {
                    if (action === "Visit Docs") {
                        vscode.env.openExternal(vscode.Uri.parse(ROBOTPY_DOCS_URL));
                    }
                });
            return false;
        }
        assert.ok(checks.systemPythonCommand);
        if (!checks.isSystemPythonNewEnough) {
            vscode.window.showErrorMessage(`Cannot install RobotPy: Your system version of Python (${checks.systemPythonCommand.versionStr}) is too old. Please upgrade to the latest version.`, "Visit Docs")
                .then(action => {
                    if (action === "Visit Docs") {
                        vscode.env.openExternal(vscode.Uri.parse(ROBOTPY_DOCS_URL));
                    }
                });
            return false;
        }
        if (!checks.hasSystemPythonVenvModule) {
            vscode.window.showErrorMessage(`Cannot install RobotPy: Your system Python installation does not include the "venv" module. Please install it in the appropriate way for your system, or reach out to a mentor for help.`);
            return false;
        }
        return true;
    }

    try {
        if (!checks.hasVenvFolder) {
            // Need to create the venv from scratch.

            if (!checkSystemPython()) {
                return false;
            }
            assert.ok(checks.systemPythonCommand);

            const userWantsToCreateVenv = await new Promise<boolean>(res => {
                vscode.window.showWarningMessage(
                    "The RobotPy extension requires a virtual environment. Would you like to create one?", "Yes (Recommended)", "No")
                    .then(action => res(action === "Yes (Recommended)"));
            });
            if (!userWantsToCreateVenv) {
                return false;
            }

            await createVenv(rootPath, checks.systemPythonCommand);
            await installLatestRobotPy(rootPath);
        } else if (!checks.isVenvPythonNewEnough) {
            // venv exists, but its Python is out of date. This should only happen
            // for old projects. Prompt the user to tear down and recreate the
            // venv.

            if (!checkSystemPython()) {
                return false;
            }
            assert.ok(checks.systemPythonCommand);

            const userWantsToReplaceVenv = await new Promise<boolean>(res => {
                vscode.window.showInformationMessage("A virtual environment already exists, but is out of date. Would you like to tear it down and recreate it?", "Yes", "No")
                    .then(action => res(action === "Yes"));
            });
            if (!userWantsToReplaceVenv) {
                return false;
            }

            outputChannel.appendLine("Deleting existing virtual environment...");
            fs.rmSync(getVenvPath(rootPath), { recursive: true, force: true });
            await createVenv(rootPath, checks.systemPythonCommand);
            await installLatestRobotPy(rootPath);
        } else if (!checks.isVenvReady) {
            // venv exists with a new enough Python, but it doesn't contain
            // robotpy. Install it with pip.
            await installLatestRobotPy(rootPath);
        }
        return true;
    } catch (e) {
        vscode.window.showErrorMessage("Cannot install RobotPy: Failed to set up the virtual environment. See the output log for details.");
        outputChannel.appendLine(`ERROR: ${e}`);
        outputChannel.show();
        return false;
    }
}

/**
 * Creates the RobotPy venv, and configures the workspace to use it. Does not
 * install RobotPy.
 *
 * Rejects if there was an error; you should run checks ahead of time (e.g. in
 * `ensureVenv`) to make sure this will not error.
 */
async function createVenv(rootPath: string, systemPy: PythonCommand): Promise<void> {
    outputChannel.appendLine("Creating virtual environment...");

    const venvPath = getVenvPath(rootPath);
    await execFancy(systemPy.cmd, [...systemPy.args, "-m", "venv", venvPath], {
        cwd: rootPath,
        showTerminal: true,
    });
    outputChannel.appendLine("Virtual environment created successfully.");

    await setWorkspacePythonInterpreter(rootPath);
}

/**
 * Installs the latest RobotPy in the venv. Does not run `robotpy sync`.
 *
 * Rejects if there was an error; you should run checks ahead of time (e.g. in
 * `ensureVenv`) to make sure this will not error.
 */
async function installLatestRobotPy(rootPath: string): Promise<void> {
    outputChannel.appendLine("Installing/upgrading RobotPy...");

    const pipPath = getVenvPipPath(rootPath);
    await execFancy(pipPath, ["install", "--upgrade", "robotpy"], {
        cwd: rootPath,
        showTerminal: true,
    });
    outputChannel.appendLine("RobotPy installed successfully.");
}

async function setWorkspacePythonInterpreter(rootPath: string): Promise<void> {
    const pythonPath = getVenvPythonPath(rootPath);
    const config = vscode.workspace.getConfiguration("python", vscode.Uri.file(rootPath));
    await config.update("defaultInterpreterPath", pythonPath, vscode.ConfigurationTarget.Workspace);
    outputChannel.appendLine(`Configured Python extension to use: ${pythonPath}`);
}

// ============================================================================
// Commands and major lifecycle moments

async function robotpyCommand(rootPath: string, args: readonly string[]) {
    return await execFancy(getVenvPythonPath(rootPath), ["-m", "robotpy", ...args], {
        showTerminal: true,
        cwd: rootPath,
        prettyName: `robotpy ${args.join(" ")}`,
    });
}

async function onProjectOpen() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        // No workspace active, so don't activate further.
        return;
    }
    const rootPath = workspaceFolders[0].uri.fsPath;

    const [checks, didError] = await checkEnvironment(rootPath);
    if (didError) {
        vscode.window.showWarningMessage("There were errors when checking the system environment for RobotPy. See the output log for details.");
    }

    // Quit early on project open if there is no robotpy project file. We do
    // this here because we do NOT want to prevent people from running
    // `robotpy init`.
    if (!checks.hasRobotPyProjectFile) {
        return;
    }

    const venvOk = await ensureVenv(rootPath, checks);
    if (!venvOk) {
        return;
    }

    const userWantsToSync = await new Promise<boolean>(res => {
        vscode.window.showInformationMessage("Would you like to run `robotpy sync` to make sure your project is up to date?", "Yes (Recommended)", "No")
            .then(action => res(action === "Yes (Recommended)"));
    });
    if (userWantsToSync) {
        outputChannel.appendLine("Running sync on project open");
        await robotpyCommand(rootPath, ["project", "update-robotpy"]);
        await robotpyCommand(rootPath, ["sync"]);
    }
}

async function ensureRobotPyReady(): Promise<boolean> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return false;
    }
    const rootPath = workspaceFolders[0].uri.fsPath;
    const [checks, checkError] = await checkEnvironment(rootPath);
    if (checkError) {
        vscode.window.showErrorMessage("Failed to check if RobotPy is ready. See the output log for details.");
        outputChannel.show();
        return false;
    }
    const venvReady = await ensureVenv(rootPath, checks);
    if (!venvReady) {
        return false;
    }
    return true;
}

function mustGetRootPath(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        throw new Error("No workspace is open");
    }
    return workspaceFolders[0].uri.fsPath;
}

async function saveCurrentFile(): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return false;
    }
    return await editor.document.save();
}

async function robotpyCommands(...cmds: string[][]) {
    await extensionInitialized;

    if (currentProcess) {
        if (await promptUserToKillCurrentProcess()) {
            outputChannel.appendLine(`Killing current process to run RobotPy commands: ${JSON.stringify(cmds)}`);
            killCurrentProcess();
        } else {
            return true;
        }
    }

    if (!await saveCurrentFile()) {
        vscode.window.showWarningMessage("Failed to save current file. Results may not be what you expect.");
        return;
    }
    if (!await ensureRobotPyReady()) {
        return;
    }
    for (const cmd of cmds) {
        await robotpyCommand(mustGetRootPath(), cmd);
    }
}
