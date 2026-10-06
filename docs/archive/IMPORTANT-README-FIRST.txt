============================================================
       ATHENA AI DESKTOP - IMPORTANT SETUP INSTRUCTIONS
============================================================

CURRENT ISSUE: Missing Electron/Node Modules
--------------------------------------------
The package you extracted is missing the required Electron runtime.
This needs to be installed before you can run Athena AI.

QUICK FIX FOR WINDOWS:
----------------------
1. Make sure Node.js is installed (download from nodejs.org if needed)
2. Double-click "QuickFix-Windows.bat" 
3. Wait 2-3 minutes for installation to complete
4. Launch Athena AI with the new "Launch-Athena.bat" file

ALTERNATIVE FIX (More thorough):
---------------------------------
1. Right-click "fix-windows-install.ps1"
2. Select "Run with PowerShell"
3. If prompted, type 'Y' to allow execution
4. Follow the on-screen instructions

FOR MAC/LINUX:
--------------
1. Open Terminal in this folder
2. Run: npm install
3. Run: ./LaunchAthena-Mac-Linux.sh

WHAT THIS FIXES:
----------------
• Installs Electron runtime
• Downloads required node_modules
• Creates proper launcher scripts
• Sets up desktop shortcuts
• Fixes Windows permissions

FIRST SIGN-IN:
--------------
See "First sign-in" in README.md. This archived page once listed
fixed default passwords; no release seeds them any more, and an install
that still has one is made to change it.

STILL HAVING ISSUES?
--------------------
• Make sure you have Node.js installed from nodejs.org
• Try running as Administrator (Windows)
• Temporarily disable antivirus during installation
• Ensure you have an internet connection for downloads

============================================================