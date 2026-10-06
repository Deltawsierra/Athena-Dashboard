# How to Launch Athena AI Desktop Application

## For Windows Users

### First Time Setup
1. Make sure Node.js is installed (you've already done this ✓)
2. Make sure you ran `npm install` in the AegisEngine folder (you've already done this ✓)

### Creating a Desktop Shortcut (The Right Way)

**IMPORTANT:** Do NOT copy or move the launch-windows.bat file to your desktop. Instead, create a shortcut:

1. Open File Explorer
2. Navigate to your AegisEngine folder (where you ran `npm install`)
3. Find the file `launch-windows.bat`
4. **Right-click** on `launch-windows.bat`
5. Select **"Send to"** → **"Desktop (create shortcut)"**
6. A shortcut will appear on your desktop named "launch-windows.bat - Shortcut"
7. You can rename this shortcut to "Athena AI" if you prefer
8. **Double-click the shortcut** on your desktop to launch the application

### Why a Shortcut?
The launcher needs to run from the application folder where all the files are installed. A shortcut tells Windows to run the file from its original location, while a copy would try to run from your desktop where the application files don't exist.

## For Mac Users

### Creating a Desktop Alias (The Right Way)

1. Open Finder
2. Navigate to your AegisEngine folder
3. Find the file `launch-mac.command`
4. Hold **Command+Option** keys
5. **Drag** `launch-mac.command` to your desktop
6. This creates an alias (you'll see a small arrow on the icon)
7. Double-click the alias to launch

## For Linux Users

### Creating a Desktop Link

1. Open Terminal
2. Navigate to your AegisEngine folder
3. Run: `ln -s $(pwd)/launch-linux.sh ~/Desktop/AthenaAI`
4. Make it executable: `chmod +x ~/Desktop/AthenaAI`
5. Double-click the link on your desktop to launch

## Troubleshooting

### "Application dependencies not found" Error
- This means the launcher can't find the installed packages
- Make sure you're using a shortcut/alias, not a copy of the launcher file
- The launcher must run from the folder where you ran `npm install`

### "Node.js is not installed" Error
- Install Node.js from https://nodejs.org/
- Choose the LTS version
- Restart your computer after installation

## First sign-in

The first sign-in is described under "First sign-in" in the top-level README.md. This archived page once listed fixed default passwords; no release seeds them any more, and an install that still has one is made to change it.