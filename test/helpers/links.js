import fs from 'fs/promises';

/**
 * Creates a filesystem link the way each platform allows for a normal user.
 *
 * macOS/Linux: a regular symlink.
 * Windows: symlinks need admin rights or Developer Mode, but any user can
 * create a directory junction (the kind tools like skills.sh create), so
 * directory and dangling links become junctions. File symlinks have no
 * unprivileged equivalent there.
 *
 * Returns false when the link type isn't permitted on this machine
 * (a file symlink on Windows without Developer Mode); other errors throw.
 */
export async function createLink(target, linkPath) {
  if (process.platform !== 'win32') {
    await fs.symlink(target, linkPath);
    return true;
  }

  const isFile = await fs.stat(target).then((stats) => stats.isFile(), () => false);
  if (!isFile) {
    await fs.symlink(target, linkPath, 'junction');
    return true;
  }

  try {
    await fs.symlink(target, linkPath, 'file');
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return false;
    throw error;
  }
}
