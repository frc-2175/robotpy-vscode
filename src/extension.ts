import * as vscode from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';

const execAsync = promisify(exec);

let outputChannel: vscode.OutputChannel;

const VENV_DIR = '.venv';

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('RobotPy');

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

function getBasePythonCommand(): string[] {
    const platform = os.platform();

    if (platform === 'win32') {
        return ['py', '-3'];
    } else {
        // macOS and Linux
        return ['python3'];
    }
}

function getVenvPath(rootPath: string): string {
    return path.join(rootPath, VENV_DIR);
}

function getVenvPythonPath(rootPath: string): string {
    const venvPath = getVenvPath(rootPath);
    const platform = os.platform();

    if (platform === 'win32') {
        return path.join(venvPath, 'Scripts', 'python.exe');
    } else {
        return path.join(venvPath, 'bin', 'python');
    }
}

function getVenvPipPath(rootPath: string): string {
    const venvPath = getVenvPath(rootPath);
    const platform = os.platform();

    if (platform === 'win32') {
        return path.join(venvPath, 'Scripts', 'pip.exe');
    } else {
        return path.join(venvPath, 'bin', 'pip');
    }
}

function venvExists(rootPath: string): boolean {
    const venvPython = getVenvPythonPath(rootPath);
    return fs.existsSync(venvPython);
}

function logCommandOutput(result: { stdout?: string; stderr?: string }) {
    if (result.stdout) {
        outputChannel.appendLine(result.stdout);
    }
    if (result.stderr) {
        outputChannel.appendLine(result.stderr);
    }
}

async function checkRobotPyProject(): Promise<boolean> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return false;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const pyprojectPath = path.join(rootPath, 'pyproject.toml');

    try {
        // Check if pyproject.toml exists
        await vscode.workspace.fs.stat(vscode.Uri.file(pyprojectPath));

        // Read the file to check if it's a robotpy project
        const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(pyprojectPath));
        const content = Buffer.from(fileContent).toString('utf8');

        if (content.includes('robotpy')) {
            // This appears to be a RobotPy project, ensure venv and robotpy are set up
            const isReady = await ensureRobotPyEnvironment(rootPath);

            if (isReady) {
                // Automatically run sync when opening the project
                await autoRunSync(rootPath);
            }

            return true;
        }
    } catch (error) {
        // pyproject.toml doesn't exist or can't be read
        return false;
    }

    return false;
}

async function autoRunSync(rootPath: string) {
    // Run sync automatically in the background
    const pythonPath = getVenvPythonPath(rootPath);
    const updateCmd = `"${pythonPath}" -m robotpy project update-robotpy`;
    const syncCmd = `"${pythonPath}" -m robotpy sync`;

    outputChannel.appendLine('\n=== Auto-running sync on project open ===');
    outputChannel.appendLine(`Running: ${updateCmd}`);
    outputChannel.appendLine(`Then: ${syncCmd}\n`);

    try {
        const terminal = vscode.window.createTerminal({
            name: 'RobotPy Auto-Sync',
            cwd: rootPath
        });

        // Don't show the terminal automatically - let it run in background
        terminal.sendText(updateCmd);
        terminal.sendText(syncCmd);

        outputChannel.appendLine('Auto-sync started in background terminal');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Auto-sync error: ${errorMessage}`);
        // Don't show error dialog for auto-sync, just log it
    }
}

async function setPythonInterpreter(rootPath: string): Promise<void> {
    const pythonPath = getVenvPythonPath(rootPath);
    const config = vscode.workspace.getConfiguration('python', vscode.Uri.file(rootPath));

    try {
        await config.update('defaultInterpreterPath', pythonPath, vscode.ConfigurationTarget.Workspace);
        outputChannel.appendLine(`Configured Python extension to use: ${pythonPath}`);
    } catch (error: any) {
        outputChannel.appendLine(`Note: Could not configure Python extension: ${error.message}`);
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

        // Configure Python extension to use the venv
        await setPythonInterpreter(rootPath);

        return true;
    } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Failed to create virtual environment: ${errorMessage}`);
        logCommandOutput(error);

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
    } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`\nFailed to install RobotPy: ${errorMessage}`);
        logCommandOutput(error);

        vscode.window.showErrorMessage('Failed to install RobotPy. Check the output for details.');
        return false;
    }
}

async function ensureRobotPyEnvironment(rootPath: string): Promise<boolean> {
    // Check if venv exists
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

        // After creating venv, install robotpy
        return await installRobotPy(rootPath);
    }

    // Venv exists, ensure Python extension is configured to use it
    await setPythonInterpreter(rootPath);

    // Check if robotpy is installed
    return await checkRobotPyInstallation(rootPath);
}

function isRobotPyInstalled(rootPath: string): boolean {
    const venvPath = getVenvPath(rootPath);
    const platform = os.platform();

    // Check for robotpy in site-packages
    let sitePackagesPath: string;
    if (platform === 'win32') {
        sitePackagesPath = path.join(venvPath, 'Lib', 'site-packages', 'robotpy');
    } else {
        // macOS and Linux - need to find the python version directory
        const libPath = path.join(venvPath, 'lib');
        if (!fs.existsSync(libPath)) {
            return false;
        }

        // Find python3.x directory
        const pythonDirs = fs.readdirSync(libPath).filter(dir => dir.startsWith('python3.'));
        if (pythonDirs.length === 0) {
            return false;
        }

        sitePackagesPath = path.join(libPath, pythonDirs[0], 'site-packages', 'robotpy');
    }

    return fs.existsSync(sitePackagesPath);
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
        vscode.env.openExternal(vscode.Uri.parse('https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-2/python-setup.html'));
    }

    return false;
}

async function executeRobotPySync() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    // Ensure venv and robotpy are set up before running command
    const isReady = await ensureRobotPyEnvironment(rootPath);
    if (!isReady) {
        return;
    }

    outputChannel.show();
    const pythonPath = getVenvPythonPath(rootPath);

    // Run project update-robotpy first, then sync
    const updateCmd = `"${pythonPath}" -m robotpy project update-robotpy`;
    const syncCmd = `"${pythonPath}" -m robotpy sync`;

    outputChannel.appendLine(`\n=== Running: ${updateCmd} ===\n`);
    outputChannel.appendLine(`Then running: ${syncCmd}\n`);

    try {
        const terminal = vscode.window.createTerminal({
            name: 'RobotPy Sync',
            cwd: rootPath
        });

        terminal.show();
        terminal.sendText(updateCmd);
        terminal.sendText(syncCmd);

        outputChannel.appendLine(`Commands started in terminal`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Error: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to execute robotpy sync: ${errorMessage}`);
    }
}

async function executeRobotPyCommand(command: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    // Ensure venv and robotpy are set up before running command
    const isReady = await ensureRobotPyEnvironment(rootPath);
    if (!isReady) {
        return;
    }

    outputChannel.show();
    const pythonPath = getVenvPythonPath(rootPath);
    const cmdString = `"${pythonPath}" -m robotpy ${command}`;
    outputChannel.appendLine(`\n=== Running: ${cmdString} ===\n`);

    try {
        const terminal = vscode.window.createTerminal({
            name: `RobotPy ${command}`,
            cwd: rootPath
        });

        terminal.show();
        terminal.sendText(cmdString);

        outputChannel.appendLine(`Command started in terminal: ${cmdString}`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Error: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to execute robotpy ${command}: ${errorMessage}`);
    }
}
