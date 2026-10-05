# Athena AI Desktop - Windows Build Instructions

## Prerequisites
Make sure you have the following installed:
- Node.js v20 or later
- npm (comes with Node.js)
- Git (optional, for version control)

## Quick Start

### 1. Install Dependencies
Open Command Prompt or PowerShell in the project directory and run:
```cmd
npm install
```

If you get any errors about missing modules, specifically install:
```cmd
npm install esbuild electron electron-builder
```

### 2. Build for Production

#### Option A: Use the batch file (Recommended)
Double-click or run:
```cmd
build-electron-windows.bat
```

#### Option B: Manual build
```cmd
# Build the server bundle
node build-electron-server.cjs

# Build the frontend
npx vite build
```

### 3. Run the Application

#### Development Mode (with hot reload):
```cmd
npm run electron
```

#### Production Mode:
```cmd
set NODE_ENV=production
npx electron electron-main.cjs
```

## Running the App - Quick Options

### Quick Run Script (Double-click):
- **`run-production.bat`** - Launches app in production mode
- **`test-electron-windows.bat`** - Tests the app with console output

## Troubleshooting

### "Cannot find module 'esbuild'" Error
Run:
```cmd
npm install esbuild
```

### ERR_BLOCKED_BY_RESPONSE or Content Security Policy Error
This has been fixed! The app now:
- Uses system fonts instead of Google Fonts
- Works completely offline
- Has proper CSP configuration
Make sure to rebuild if you still see this error:
```cmd
build-electron-windows.bat
```

### "Cannot find module 'electron'" Error
Run:
```cmd
npm install electron
```

### Build Errors
1. Delete node_modules and dist folders
2. Run `npm install` again
3. Try building again

### App Won't Start
Make sure the server bundle exists:
- Check if `dist/server-electron.mjs` exists
- If not, run: `node build-electron-server.cjs`

## First sign-in
The first sign-in is described under "First sign-in" in the top-level README.md. This archived page once listed fixed default passwords; no release seeds them any more, and an install that still has one is made to change it.

## Creating an Installer (Optional)

To create a Windows installer (.exe):

1. Install electron-builder if not already installed:
```cmd
npm install --save-dev electron-builder
```

2. Run the packaging command:
```cmd
npm run dist
```

This will create an installer in the `dist` folder.

## Project Structure
```
AegisEngine/
├── dist/                      # Built files (created after build)
│   ├── public/               # Frontend assets
│   ├── server-electron.mjs  # Bundled server
│   └── node_modules/        # Native modules
├── client/                   # Frontend source code
├── server/                   # Backend source code
├── electron-main.cjs        # Electron main process
├── build-electron-server.cjs # Server build script
└── build-electron-windows.bat # Windows build script
```

## Notes
- The app runs entirely offline with a local SQLite database
- All data is stored locally in `athena.db`
- The app uses a custom `app://` protocol for security
- No internet connection required after installation