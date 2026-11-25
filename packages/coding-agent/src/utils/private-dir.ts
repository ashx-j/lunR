import { chmodSync, lstatSync, mkdirSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";

/**
 * Why `stat` (from lstat) is not a directory only this user can use, or undefined: a symlink, another
 * owner, or any group or other permission bit. Fixed names under /tmp can be created first by anyone.
 * The intercom broker applies the same rule inline (`ensurePrivateSocketDir`) because its files are
 * compiled and run on their own and cannot import from here.
 */
function privateDirProblem(stat: Stats): string | undefined {
	const uid = process.getuid?.();
	if (!stat.isDirectory()) return "is not a directory"; // also a symlink, since this is lstat
	if (uid !== undefined && stat.uid !== uid) return `is owned by uid ${stat.uid}, not ${uid}`;
	if (stat.mode & 0o077) return `has mode ${(stat.mode & 0o777).toString(8).padStart(4, "0")}; it must be 0700`;
	return undefined;
}

/**
 * Makes `dir` (its parent must exist) a 0700 directory of this user. One this user owns with looser
 * bits was made by an older lunR: it is set to 0700, and with `contents` everything in it too (dirs
 * 0700, files 0600), refusing an entry another user owns or a symlink, since others could write there
 * while it was loose. A symlink or another owner at `dir` itself is refused.
 */
export function securePrivateDir(dir: string, contents = true): void {
	try {
		mkdirSync(dir, { mode: 0o700 });
		chmodSync(dir, 0o700); // the umask may have cleared bits of 0700
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const stat = lstatSync(dir);
	const problem = privateDirProblem(stat);
	if (!problem) return;
	const uid = process.getuid?.();
	// lstat: a symlink is never a directory here.
	if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
		throw new Error(`${dir} ${problem}. Remove it and run lunR again.`);
	}
	if (contents) tightenTree(dir);
	else chmodSync(dir, 0o700);
}

function tightenTree(dir: string): void {
	const uid = process.getuid?.();
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
			throw new Error(`${path} is a symlink or belongs to another user. Remove ${dir} and run lunR again.`);
		}
		if (stat.isDirectory()) tightenTree(path);
		else chmodSync(path, 0o600);
	}
	chmodSync(dir, 0o700);
}
