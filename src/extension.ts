import * as vscode from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';

const execAsync = promisify(exec);

let outputChannel: vscode.OutputChannel;
let robotpyTerminal: vscode.Terminal | undefined;

const VENV_DIR = '.venv';
const ROBOTPY_DOCS_URL = 'https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-2/python-setup.html';
const TERMINAL_NAME = 'RobotPy';
const OUTPUT_CHANNEL_NAME = 'RobotPy';

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('robotpy.sync', () => executeRobotPySync()),
        vscode.commands.registerCommand('robotpy.sim', () => executeRobotPyCommand('sim')),
        vscode.commands.registerCommand('robotpy.deploy', () => executeRobotPyCommand('deploy')),
        vscode.commands.registerCommand('robotpy.deploySkipTests', () => executeRobotPyCommand('deploy --skip-tests'))
    );

    // Check if this is a RobotPy project when activated
    checkRobotPyProject();
}

export function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
}

function isWindows(): boolean {
    return os.platform() === 'win32';
}

function getBasePythonCommand(): string[] {
    return isWindows() ? ['py', '-3'] : ['python3'];
}

function getVenvPath(rootPath: string): string {
    return path.join(rootPath, VENV_DIR);
}

function getVenvPythonPath(rootPath: string): string {
    const venvPath = getVenvPath(rootPath);
    return isWindows()
        ? path.join(venvPath, 'Scripts', 'python.exe')
        : path.join(venvPath, 'bin', 'python');
}

function getVenvPipPath(rootPath: string): string {
    const venvPath = getVenvPath(rootPath);
    return isWindows()
        ? path.join(venvPath, 'Scripts', 'pip.exe')
        : path.join(venvPath, 'bin', 'pip');
}

function venvExists(rootPath: string): boolean {
    const venvPython = getVenvPythonPath(rootPath);
    return fs.existsSync(venvPython);
}

function logCommandOutput(result: { stdout?: string; stderr?: string }): void {
    if (result.stdout) {
        outputChannel.appendLine(result.stdout);
    }
    if (result.stderr) {
        outputChannel.appendLine(result.stderr);
    }
}

function handleCommandError(error: unknown, context: string): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`${context}: ${errorMessage}`);
    logCommandOutput(error as any);
}

function buildRobotPyCommand(rootPath: string, args: string): string {
    const pythonPath = getVenvPythonPath(rootPath);
    return `"${pythonPath}" -m robotpy ${args}`;
}

function getRobotPyTerminal(rootPath: string): vscode.Terminal {
    if (robotpyTerminal && vscode.window.terminals.includes(robotpyTerminal)) {
        return robotpyTerminal;
    }

    robotpyTerminal = vscode.window.createTerminal({
        name: TERMINAL_NAME,
        cwd: rootPath
    });

    return robotpyTerminal;
}

async function checkRobotPyProject(): Promise<boolean> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return false;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const pyprojectPath = path.join(rootPath, 'pyproject.toml');

    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(pyprojectPath));

        const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(pyprojectPath));
        const content = Buffer.from(fileContent).toString('utf8');

        if (content.includes('robotpy')) {
            const isReady = await ensureRobotPyEnvironment(rootPath);

            if (isReady) {
                await autoRunSync(rootPath);
            }

            return true;
        }
    } catch (error) {
        return false;
    }

    return false;
}

async function autoRunSync(rootPath: string): Promise<void> {
    const updateCmd = buildRobotPyCommand(rootPath, 'project update-robotpy');
    const syncCmd = buildRobotPyCommand(rootPath, 'sync');

    outputChannel.appendLine('\n=== Auto-running sync on project open ===');
    outputChannel.appendLine(`Running: ${updateCmd}`);
    outputChannel.appendLine(`Then: ${syncCmd}\n`);

    try {
        const terminal = getRobotPyTerminal(rootPath);
        terminal.sendText(updateCmd);
        terminal.sendText(syncCmd);

        outputChannel.appendLine('Auto-sync started in background terminal');
    } catch (error) {
        handleCommandError(error, 'Auto-sync error');
    }
}

async function setPythonInterpreter(rootPath: string): Promise<void> {
    const pythonPath = getVenvPythonPath(rootPath);
    const config = vscode.workspace.getConfiguration('python', vscode.Uri.file(rootPath));

    try {
        await config.update('defaultInterpreterPath', pythonPath, vscode.ConfigurationTarget.Workspace);
        outputChannel.appendLine(`Configured Python extension to use: ${pythonPath}`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Note: Could not configure Python extension: ${errorMessage}`);
    }
}

async function createVenv(rootPath: string): Promise<boolean> {
    outputChannel.show();
    outputChannel.appendLine('Creating virtual environment...');

    try {
        const pythonCmd = getBasePythonCommand();
        const venvPath = getVenvPath(rootPath);
        const cmd = [...pythonCmd, '-m', 'venv', venvPath].join(' ');
        outputChannel.appendLine(`Running: ${cmd}\n`);

        const result = await execAsync(cmd, { cwd: rootPath });
        logCommandOutput(result);

        outputChannel.appendLine('Virtual environment created successfully.\n');

        await setPythonInterpreter(rootPath);

        return true;
    } catch (error) {
        handleCommandError(error, 'Failed to create virtual environment');
        vscode.window.showErrorMessage('Failed to create virtual environment. Please ensure Python 3 is installed.');
        return false;
    }
}

async function installRobotPy(rootPath: string): Promise<boolean> {
    outputChannel.show();
    outputChannel.appendLine('Installing/upgrading RobotPy...');
    outputChannel.appendLine('This may take a few minutes...\n');

    try {
        const pipPath = getVenvPipPath(rootPath);
        const cmd = `"${pipPath}" install --upgrade robotpy`;

        const result = await execAsync(cmd, { cwd: rootPath, maxBuffer: 1024 * 1024 * 10 });
        logCommandOutput(result);

        outputChannel.appendLine('\nRobotPy installed successfully.');
        return true;
    } catch (error) {
        handleCommandError(error, '\nFailed to install RobotPy');
        vscode.window.showErrorMessage('Failed to install RobotPy. Check the output for details.');
        return false;
    }
}

async function ensureRobotPyEnvironment(rootPath: string): Promise<boolean> {
    if (!venvExists(rootPath)) {
        const result = await vscode.window.showInformationMessage(
            'RobotPy requires a virtual environment. Would you like to create one?',
            'Yes',
            'No'
        );

        if (result !== 'Yes') {
            return false;
        }

        const created = await createVenv(rootPath);
        if (!created) {
            return false;
        }

        return await installRobotPy(rootPath);
    }

    await setPythonInterpreter(rootPath);

    return await checkRobotPyInstallation(rootPath);
}

function getSitePackagesPath(rootPath: string): string | null {
    const venvPath = getVenvPath(rootPath);

    if (isWindows()) {
        return path.join(venvPath, 'Lib', 'site-packages', 'robotpy');
    }

    const libPath = path.join(venvPath, 'lib');
    if (!fs.existsSync(libPath)) {
        return null;
    }

    const pythonDirs = fs.readdirSync(libPath).filter(dir => dir.startsWith('python3.'));
    if (pythonDirs.length === 0) {
        return null;
    }

    return path.join(libPath, pythonDirs[0], 'site-packages', 'robotpy');
}

function isRobotPyInstalled(rootPath: string): boolean {
    const sitePackagesPath = getSitePackagesPath(rootPath);
    return sitePackagesPath !== null && fs.existsSync(sitePackagesPath);
}

async function checkRobotPyInstallation(rootPath: string): Promise<boolean> {
    if (isRobotPyInstalled(rootPath)) {
        outputChannel.appendLine('RobotPy installation check passed.');
        return true;
    }

    // RobotPy is not installed in venv
    outputChannel.appendLine('RobotPy is not installed in the virtual environment.');

    const result = await vscode.window.showWarningMessage(
        'RobotPy is not installed in the virtual environment. Would you like to install it?',
        'Yes',
        'View Installation Guide',
        'No'
    );

    if (result === 'Yes') {
        return await installRobotPy(rootPath);
    } else if (result === 'View Installation Guide') {
        vscode.env.openExternal(vscode.Uri.parse(ROBOTPY_DOCS_URL));
    }

    return false;
}

async function getWorkspaceRootAndEnsureReady(): Promise<string | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return null;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const isReady = await ensureRobotPyEnvironment(rootPath);

    return isReady ? rootPath : null;
}

async function executeRobotPySync(): Promise<void> {
    const rootPath = await getWorkspaceRootAndEnsureReady();
    if (!rootPath) {
        return;
    }

    outputChannel.show();

    const updateCmd = buildRobotPyCommand(rootPath, 'project update-robotpy');
    const syncCmd = buildRobotPyCommand(rootPath, 'sync');

    outputChannel.appendLine(`\n=== Running: ${updateCmd} ===`);
    outputChannel.appendLine(`Then running: ${syncCmd}\n`);

    try {
        outputChannel.appendLine('Starting commands in terminal');
        const terminal = getRobotPyTerminal(rootPath);
        terminal.show();
        terminal.sendText(updateCmd);
        terminal.sendText(syncCmd);
    } catch (error) {
        handleCommandError(error, 'Failed to execute robotpy sync');
        vscode.window.showErrorMessage('Failed to execute robotpy sync. Check the output for details.');
    }
}

async function executeRobotPyCommand(command: string): Promise<void> {
    const rootPath = await getWorkspaceRootAndEnsureReady();
    if (!rootPath) {
        return;
    }

    outputChannel.show();

    const cmdString = buildRobotPyCommand(rootPath, command);
    outputChannel.appendLine(`\n=== Running: ${cmdString} ===\n`);

    try {
        outputChannel.appendLine(`Starting command in terminal: ${cmdString}`);
        const terminal = getRobotPyTerminal(rootPath);
        terminal.show();
        terminal.sendText(cmdString);
    } catch (error) {
        handleCommandError(error, `Failed to execute robotpy ${command}`);
        vscode.window.showErrorMessage(`Failed to execute robotpy ${command}. Check the output for details.`);
    }
}
