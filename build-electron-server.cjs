// Build script for Electron production server
const { build } = require('esbuild');
const path = require('path');
const fs = require('fs');

// Build the server as **CommonJS**, not ESM. Exported: a test builds the same bundles to boot them
// (tests/the-event-loop-never-loads-the-sqlite-driver.test.ts).
const options = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',                           // <-- CHANGED
    external: [
        'better-sqlite3',  // native module
        'sqlite3',         // native module (if used)
        'electron',        // Electron itself
    ],
    loader: {
        '.ts': 'ts',
        '.tsx': 'tsx',
        '.js': 'js',
        '.jsx': 'jsx',
    },
    define: {
        'process.env.NODE_ENV': '"production"',
        'process.env.USE_SQLITE': '"true"',
    },
    minify: false,
    sourcemap: false,
};

async function buildElectronServer() {
    console.log('Building Electron server bundle...');

    try {
        await build({ ...options, entryPoints: ['server/index-electron.ts'], outfile: 'dist/server-electron.cjs' });
        console.log('✓ Server bundled successfully to dist/server-electron.cjs');

        // The store's worker thread (server/store-client.ts): better-sqlite3 and
        // every statement run there, off the event loop. The server starts it
        // from this file, beside its own (server/store-worker-file.ts).
        await build({ ...options, entryPoints: ['server/store-worker-main.ts'], outfile: 'dist/store-worker.cjs' });
        console.log('✓ The store\'s worker bundled successfully to dist/store-worker.cjs');

        // better-sqlite3 is deliberately NOT copied into dist/node_modules.
        //
        // The copy shadowed the real one: require('better-sqlite3') from
        // dist/server-electron.cjs resolved to dist/node_modules first, and that
        // copy was taken before electron-builder rebuilt the native module, so
        // the packaged app loaded a binary built for Node's ABI and died on
        // startup with NODE_MODULE_VERSION 127 against Electron's 130. Without
        // the copy the require walks up to the top-level node_modules that
        // electron-builder rebuilds and unpacks for us.

        console.log('\n✅ Electron server build complete!');
        console.log('Files created:');
        console.log(' - dist/server-electron.cjs (bundled server)');
        console.log(' - dist/store-worker.cjs (the store\'s worker thread)');
        console.log(' - better-sqlite3 is resolved from node_modules, rebuilt by electron-builder');
    } catch (error) {
        console.error('Build failed:', error);
        process.exit(1);
    }
}

if (require.main === module) buildElectronServer();

module.exports = { options };
