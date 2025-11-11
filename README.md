# RobotPy for VS Code

A VS Code extension that adds commands and graphical menus for [RobotPy](https://robotpy.readthedocs.io/en/stable/).

It can be installed from the VS Code extension marketplace (link tbd).

## Warnings

This extension is designed for beginners and does not attempt to expose all RobotPy features. It cannot be used to create a new RobotPy project. It has the following opinionated behaviors:

- The extension will always create a venv in a folder named `.venv`, and will immediately configure the VS Code Python extension to use it.
- When opening a RobotPy project, it will automatically upgrade the `robotpy_version` in `pyproject.toml` and run `robotpy sync`.

## Usage

Once the extension is installed, two new menu items will appear next to the Run button in the editor title bar. The robot button deploys code to a robot (`robotpy deploy`), while the computer button launches the simulator (`robotpy sim`). You can also access RobotPy commands from the command palette by pressing Ctrl-Shift-P (or Cmd-Shift-P on macOS).
