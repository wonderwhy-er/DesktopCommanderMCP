import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('real POSIX terminal consumes arrow/wheel sequences without echo and restores settings', {
    skip: process.platform === 'win32',
    timeout: 20000,
}, () => {
    const program = String.raw`
import os, pty, select, shutil, subprocess, tempfile, termios, time
root=os.getcwd()
home=tempfile.mkdtemp(prefix='dct-')
sock=os.path.join(home,'events.sock')
master,slave=pty.openpty()
before=termios.tcgetattr(slave)
env=dict(os.environ, DC_ACTIVITY_SOCKET=sock, TERM='xterm-256color')
child=subprocess.Popen(['node',os.path.join(root,'dist/index.js'),'activity'],stdin=slave,stdout=slave,stderr=slave,env=env,cwd=root)
output=bytearray()
try:
    deadline=time.monotonic()+7
    while time.monotonic()<deadline and not os.path.exists(sock):
        readable,_,_=select.select([master],[],[],0.05)
        if readable:
            try: output+=os.read(master,65536)
            except OSError: break
    assert os.path.exists(sock),'monitor socket never opened'
    # 300 navigation events + split SGR mouse-wheel sequence.
    os.write(master,b'\x1b[A\x1b[B'*150 + b'\x1b[5~\x1b[6~\x1b[<64;20;9M\x1b[<65;20;9M')
    time.sleep(.15)
    os.write(master,b'q')
    deadline=time.monotonic()+5
    while time.monotonic()<deadline and child.poll() is None:
        readable,_,_=select.select([master],[],[],0.05)
        if readable:
            try: output+=os.read(master,65536)
            except OSError: break
    child.wait(timeout=3)
    assert child.returncode == 0, 'monitor exit %s' % child.returncode
    assert b'DESKTOP COMMANDER' in output
    assert b'^[[A' not in output and b'^[[B' not in output, 'arrow keys echoed literally'
    assert b'\x1b[?1049h' in output and b'\x1b[?1049l' in output, 'alternate screen was not restored'
    assert b'\x1b[?1000h' in output and b'\x1b[?1000l' in output, 'mouse tracking was not restored'
    after=termios.tcgetattr(slave)
    assert (before[3] & termios.ECHO) == (after[3] & termios.ECHO), 'terminal ECHO flag not restored'
    assert (before[3] & termios.ICANON) == (after[3] & termios.ICANON), 'terminal canonical input not restored'
    print('PTY_NAVIGATION_AND_RESTORE_OK')
finally:
    if child.poll() is None:
        child.terminate()
        try: child.wait(timeout=2)
        except subprocess.TimeoutExpired: child.kill()
    os.close(master);os.close(slave);shutil.rmtree(home,ignore_errors=True)
`;
    const result = spawnSync('python3', ['-c', program], {
        cwd: path.resolve('.'),
        timeout: 15000,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /PTY_NAVIGATION_AND_RESTORE_OK/);
});
