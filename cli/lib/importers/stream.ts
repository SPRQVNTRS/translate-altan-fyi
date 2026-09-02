/**
 * Read a dump line by line, whatever it is compressed with.
 *
 * WHY A CHILD PROCESS AND NOT AN NPM PACKAGE
 *   Node ships gzip in `node:zlib`, and it does not ship bzip2. The dumps this
 *   CLI reads arrive as `.tar.bz2`, so something has to decompress bzip2. The
 *   two candidates are a pure-JS package and the `tar` / `bunzip2` binaries
 *   that are already on every machine that runs this command.
 *
 *   The binaries win. Adding a dependency to open a file the operator
 *   downloaded by hand is a dependency for nothing, and pure-JS bzip2 is far
 *   slower than the system binary on a 450 MB archive, which is the exact case
 *   that matters here.
 *
 * WHY THE CHILD'S FAILURE MUST NOT BE SILENT
 *   A truncated archive decompresses happily up to the point where it was cut
 *   and then exits non-zero. Its stdout simply ends. If we only read stdout we
 *   see a stream that finished, so a half-read dump looks exactly like a short
 *   but successful import, and the missing rows are discovered weeks later.
 *   So the exit code is checked, and a non-zero exit throws with the tail of
 *   the child's stderr in the message.
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';

/** How much of the child's stderr we keep. Enough for the real message, bounded so a chatty child cannot fill memory. */
const STDERR_CAP_BYTES = 8 * 1024;

interface DecompressCommand {
  binary: string;
  args: string[];
}

/**
 * Pick a decompressor from the file name.
 *
 * `.tar.bz2` is tested before `.bz2`, because a tar archive also ends in
 * `.bz2` and `bunzip2 -c` on one would hand us the tar header bytes as if they
 * were content.
 */
function decompressCommandFor(file: string): DecompressCommand | null {
  const name = file.toLowerCase();
  if (name.endsWith('.tar.bz2') || name.endsWith('.tbz2')) {
    return { binary: 'tar', args: ['-xjOf', file] };
  }
  if (name.endsWith('.bz2')) {
    return { binary: 'bunzip2', args: ['-c', file] };
  }
  return null;
}

/** Gzip is handled in process, because Node has it and spawning would buy nothing. */
function readableFor(file: string): Readable {
  if (file.toLowerCase().endsWith('.gz')) {
    return createReadStream(file).pipe(createGunzip());
  }
  return createReadStream(file);
}

async function* linesOf(input: Readable): AsyncGenerator<string> {
  input.setEncoding('utf8');
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      yield line;
    }
  } finally {
    reader.close();
  }
}

async function* linesFromChild(command: DecompressCommand, file: string): AsyncGenerator<string> {
  const child = spawn(command.binary, command.args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderrTail.length >= STDERR_CAP_BYTES) return;
    stderrTail += chunk.slice(0, STDERR_CAP_BYTES - stderrTail.length);
  });

  const exited = new Promise<void>((resolve, reject) => {
    // `error` fires when the binary is not there at all. Node's own message for
    // that is `spawn tar ENOENT`, which names no remedy, so we say what is
    // missing and what to do about it.
    child.on('error', (cause: Error) => {
      reject(
        new Error(
          `Cannot run "${command.binary}". Install it, or put it on PATH, then run the import again. ${cause.message}`,
        ),
      );
    });
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const how = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`;
      reject(
        new Error(
          `"${command.binary} ${command.args.join(' ')}" failed with ${how} while reading ${file}. The dump is probably truncated. stderr: ${stderrTail.trim()}`,
        ),
      );
    });
  });
  // Park a handler on the promise straight away. Without it, a child that fails
  // before the consumer has read a single line rejects with nobody listening,
  // and Node reports an unhandled rejection instead of our message.
  exited.catch(() => undefined);

  try {
    yield* linesOf(child.stdout);
  } finally {
    // The consumer can stop early, which is what --max-rows does. Killing the
    // child here is the difference between stopping and leaving a bunzip2
    // grinding through the remaining 450 MB for output nobody will read.
    child.kill();
  }

  // Only reached when the stream ended on its own. An early return above skips
  // this on purpose, because the exit we just caused with kill() is not a fault.
  await exited;
}

/**
 * Yield the dump one line at a time.
 *
 * The whole point is that the dump is never held in memory: the decompressor
 * streams, readline splits, and this generator hands out one line at a time.
 */
export async function* readLines(file: string): AsyncGenerator<string> {
  const command = decompressCommandFor(file);
  if (command === null) {
    yield* linesOf(readableFor(file));
    return;
  }
  yield* linesFromChild(command, file);
}
