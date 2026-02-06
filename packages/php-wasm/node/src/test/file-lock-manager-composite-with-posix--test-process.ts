// eslint-disable-next-line @nx/enforce-module-boundaries
import { FileLockManagerForPosix } from '@php-wasm/node';
import {
	FileLockManagerInMemory,
	FileLockManagerComposite,
	exposeAPI,
} from '@php-wasm/universal';
import { createRemoteProcessAPIFromFileLockManager } from './file-lock-manager-test-utils';

// Each child process creates its own FileLockManagerInMemory rather
// than sharing one from the main test thread. This is intentional:
// the child process tests verify that FileLockManagerComposite
// effectively locks files across OS processes, where cross-process
// coordination is handled by the native lock manager (POSIX fcntl).
const fileLockManager = new FileLockManagerComposite(
	new FileLockManagerForPosix(),
	new FileLockManagerInMemory()
);
const api = createRemoteProcessAPIFromFileLockManager(fileLockManager);
// TODO: Fix type error
// @ts-ignore
exposeAPI(api, null, process as NodeProcess);

process.on('uncaughtException', (err) => {
	// eslint-disable-next-line no-console
	console.error('There was an uncaught error', err);
});
