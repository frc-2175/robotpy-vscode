import assert from 'assert';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

let outputChannel: vscode.OutputChannel;
let robotpyTerminal: vscode.Terminal | undefined;

const VENV_DIR = '.venv';
const PYTHON_MIN_VERSION = [3, 12];

const TERMINAL_NAME = 'RobotPy';
const OUTPUT_CHANNEL_NAME = 'RobotPy';
const ROBOTPY_DOCS_URL = "https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-2/python-setup.html";

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

    // Register commands.
    context.subscriptions.push(
        // TODO: Add init command.
        vscode.commands.registerCommand('robotpy.sync', () => robotpyCommands("project update-robotpy", "sync")),
        vscode.commands.registerCommand('robotpy.sim', () => robotpyCommands("sim")),
        vscode.commands.registerCommand('robotpy.deploy', () => robotpyCommands("deploy")),
        vscode.commands.registerCommand('robotpy.deploySkipTests', () => robotpyCommands("deploy --skip-tests")),
    );

    onProjectOpen();
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

function getVenvActivateCmd(rootPath: string): string {
    return isWindows()
        ? path.join(getVenvPath(rootPath), "Scripts", "activate")
        : `source "${path.join(getVenvPath(rootPath), "bin", "activate")}"`;
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

function logCommandOutput(result: { stdout?: string; stderr?: string }) {
    if (result.stdout) {
        outputChannel.appendLine(result.stdout);
    }
    if (result.stderr) {
        outputChannel.appendLine(result.stderr);
    }
}

interface PythonCommand {
    /** The command to run to invoke Python. These will already be quoted if necessary. */
    cmd: string[],
    /** The Python major/minor version numbers. */
    version: [number, number],
    /** The Python major.minor version as a string. */
    versionStr: string,
}

async function findPythonCommand(venvPath?: string): Promise<PythonCommand | null> {
    let candidates = [["python3"], ["python"], ["py", "-3"], ["py"]];
    if (venvPath) {
        candidates = [
            ...candidates.map(c => [`"${path.join(venvPath, "bin", c[0])}"`, ...c.slice(1)]),
            ...candidates.map(c => [`"${path.join(venvPath, "Scripts", c[0])}"`, ...c.slice(1)]),
        ];
    }
    for (const candidate of candidates) {
        try {
            let executable = candidate[0];
            const args = candidate.slice(1);

            const { stdout, stderr } = await execAsync(`${executable} ${args.join(" ")} --version`);
            const out = stdout || stderr; // python may print version to stderr

            const match = out.match(/Python\s+(\d+)\.(\d+)/i);
            if (!match) continue;

            const major = parseInt(match[1], 10);
            const minor = parseInt(match[2], 10);

            return {
                cmd: candidate,
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
    venvPythonCommand: PythonCommand | null

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
    const systemPython = await findPythonCommand();
    if (systemPython) {
        result.hasSystemPython = true;
        result.systemPythonCommand = systemPython;

        if (systemPython.version[0] >= PYTHON_MIN_VERSION[0] && systemPython.version[1] >= PYTHON_MIN_VERSION[1]) {
            result.isSystemPythonNewEnough = true;

            try {
                await execAsync(`${systemPython.cmd} -c "import venv"`);
                result.hasSystemPythonVenvModule = true;
            } catch (e) {
                // Empty catch should be ok here because we just verified that
                // the given Python command works. But for sanity, we still log
                // whatever happens here.
                outputChannel.appendLine(`Expected (?) error when checking for system venv module: ${e}`);
            }
        }
    }

    // Check status of venv
    if (fs.existsSync(getVenvPath(rootPath))) {
        result.hasVenvFolder = true;

        const venvPython = await findPythonCommand(getVenvPath(rootPath));
        if (venvPython) {
            result.venvPythonCommand = venvPython
            if (venvPython.version[0] >= PYTHON_MIN_VERSION[0] && venvPython.version[1] >= PYTHON_MIN_VERSION[1]) {
                result.isVenvPythonNewEnough = true;

                try {
                    await execAsync(`${venvPython.cmd} -c "import robotpy"`);
                    result.isVenvReady = true;
                } catch (e) {
                    outputChannel.appendLine(`Expected (?) error when checking for robotpy in venv: ${e}`);
                }
            }
        }
    }

    if (isWindows()) {
        // Check PowerShell execution policy (thank you Microsoft)
        try {
            const { stdout, stderr } = await execAsync(`powershell -NoProfile -NonInteractive -Command "Get-ExecutionPolicy -Scope Process"`);
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

function getRobotPyTerminal(): vscode.Terminal {
    if (robotpyTerminal && vscode.window.terminals.includes(robotpyTerminal)) {
        return robotpyTerminal;
    }

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    robotpyTerminal = vscode.window.createTerminal({
        name: TERMINAL_NAME,
        cwd: rootPath,
        isTransient: true,
    });
    if (rootPath) {
        robotpyTerminal.sendText(getVenvActivateCmd(rootPath));
    }
    return robotpyTerminal;
}

function closeRobotPyTerminal() {
    robotpyTerminal?.dispose();
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
    // If PowerShell won't let us activate venvs, then there is no reason to proceed.
    if (!checks.winExecutionPolicyOk) {
        vscode.window.showErrorMessage("Your system's PowerShell execution policy is incompatible with Python virtual environments. See the output log for details.");
        outputChannel.appendLine("Your PowerShell execution policy does not allow scripts to execute, which will prevent VS Code from activating Python virtual environments. To fix this, do the following:");
        outputChannel.appendLine(" 1. Open a PowerShell window as Administrator.");
        outputChannel.appendLine(" 2. Run the following command: Set-ExecutionPolicy RemoteSigned")
        return false;
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
                vscode.window.showInformationMessage("The RobotPy extension requires a virtual environment. Would you like to create one?", "Yes", "No")
                    .then(action => res(action === "Yes"));
            });
            if (!userWantsToCreateVenv) {
                return false;
            }

            closeRobotPyTerminal();
            outputChannel.show();
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

            closeRobotPyTerminal();
            outputChannel.show();
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
    outputChannel.appendLine('Creating virtual environment...');

    const venvPath = getVenvPath(rootPath);
    const cmd = [...systemPy.cmd, '-m', 'venv', venvPath].join(' ');
    outputChannel.appendLine(`Running: ${cmd}\n`);

    const result = await execAsync(cmd, { cwd: rootPath });
    logCommandOutput(result);
    outputChannel.appendLine('Virtual environment created successfully.\n');

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
    const result = await execAsync(`"${pipPath}" install --upgrade robotpy`, { cwd: rootPath });
    logCommandOutput(result);
    outputChannel.appendLine("\nRobotPy installed successfully.");
}

async function setWorkspacePythonInterpreter(rootPath: string): Promise<void> {
    const pythonPath = getVenvPythonPath(rootPath);
    const config = vscode.workspace.getConfiguration('python', vscode.Uri.file(rootPath));
    await config.update('defaultInterpreterPath', pythonPath, vscode.ConfigurationTarget.Workspace);
    outputChannel.appendLine(`Configured Python extension to use: ${pythonPath}`);
}

// ====================================
// Commands and major lifecycle moments

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
    if (!checks.hasRobotPyProjectFile) {
        return;
    }
    const venvOk = await ensureVenv(rootPath, checks);
    if (!venvOk) {
        return;
    }

    outputChannel.appendLine("\nAuto-running sync on project open");
    const terminal = getRobotPyTerminal();
    terminal.show();
    terminal.sendText("robotpy project update-robotpy");
    terminal.sendText("robotpy sync");
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

async function robotpySync() {
    if (!await ensureRobotPyReady()) {
        return;
    }
    const terminal = getRobotPyTerminal();
    terminal.show();
    terminal.sendText("robotpy project update-robotpy");
    terminal.sendText("robotpy sync");
}

async function robotpyCommands(...cmds: string[]) {
    if (!await ensureRobotPyReady()) {
        return;
    }

    const terminal = getRobotPyTerminal();
    terminal.show();
    for (const cmd of cmds) {
        terminal.sendText(`robotpy ${cmd}`);
    }
}
