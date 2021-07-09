'use strict';

const path = require('path');
const fs = require('fs-extra');
const execa = require('execa');
const fixturify = require('fixturify');
const { createTmpDir } = require('./tmp');
const {
  gitInit: _gitInit,
  gitStatus,
  gitRemoveAll
} = require('git-diff-apply');

const branchName = 'foo';
const branchRegExp = new RegExp(`^\\* ${branchName}\\r?\\n {2}master$`);

async function git(args, options) {
  let { stdout } = await execa('git', args, options);

  return stdout;
}

function toLines(string) {
  return string.split(/\r?\n/).filter(Boolean);
}

async function gitInit({
  cwd
} = {}) {
  if (!cwd) {
    cwd = await createTmpDir();
  }

  await _gitInit({
    cwd
  });

  await git(['config', 'merge.tool', 'vimdiff'], {
    cwd
  });

  await git(['config', 'mergetool.keepBackup', 'false'], {
    cwd
  });

  await commit({
    cwd
  });

  return cwd;
}

async function commit({
  m = 'initial empty commit to create master branch',
  tag,
  cwd
}) {
  await git(['add', '-A'], {
    cwd
  });

  // allow empty first commit
  // or no changes between tags
  await git(['commit', '--allow-empty', '-m', m], {
    cwd
  });

  if (tag) {
    await git(['tag', tag], {
      cwd
    });
  }
}

async function postCommit({
  cwd,
  dirty
}) {
  // non-master branch test
  await git(['checkout', '-b', branchName], {
    cwd
  });

  if (dirty) {
    await fs.writeFile(path.join(cwd, 'a-random-new-file'), 'bar');
  }
}

async function buildTmp({
  fixturesPath,
  dirty,
  noGit,
  subDir = ''
}) {
  let tmpPath = await createTmpDir();

  await gitInit({
    cwd: tmpPath
  });

  let tmpSubPath = path.join(tmpPath, subDir);

  let tags = await fs.readdir(fixturesPath);

  for (let i = 0; i < tags.length; i++) {
    if (i !== 0) {
      await gitRemoveAll({
        cwd: tmpPath
      });
    }

    let tag = tags[i];

    await fs.ensureDir(tmpSubPath);

    let tagPath = path.join(fixturesPath, tag);

    let files = await fs.readdir(tagPath);

    // if only a single .gitkeep, treat as an empty dir
    // and skip the copy
    if (!(files.length === 1 && files[0] === '.gitkeep')) {
      await fs.copy(tagPath, tmpSubPath);
    }

    await commit({
      m: tag,
      tag,
      cwd: tmpPath
    });
  }

  await postCommit({
    cwd: tmpPath,
    dirty
  });

  if (noGit) {
    await fs.remove(path.join(tmpSubPath, '.git'));
  }

  return tmpSubPath;
}

function processBin({
  binFile,
  bin,
  args = [],
  cwd,
  commitMessage,
  expect
}) {
  let ps;
  if (binFile) {
    // `execa.node` will pass along debugger port options when debugging,
    // and you'll get an error like
    // "Starting inspector on 127.0.0.1:34110 failed: address already in use"
    ps = execa('node', [path.join(process.cwd(), 'bin', binFile), ...args], {
      cwd
    });
  } else {
    ps = execa(bin, args, {
      cwd,
      preferLocal: true,
      localDir: process.cwd()
    });
  }

  let promise = processIo({
    ps,
    cwd,
    commitMessage,
    expect
  });

  return {
    ps,
    promise
  };
}

async function processIo({
  ps,
  cwd,
  commitMessage,
  expect
}) {
  return await new Promise((resolve, reject) => {
    ps.stdout.on('data', data => {
      let str = data.toString();
      if (str.includes('Normal merge conflict')) {
        ps.stdin.write(':%diffg 3\n');
        ps.stdin.write(':wqa\n');
      } else if (str.includes('Deleted merge conflict')) {
        ps.stdin.write('d\n');
      }
    });

    let stderr = '';

    ps.stderr.on('data', data => {
      stderr += data.toString();
    });

    ps.stderr.pipe(process.stdout);

    ps.on('exit', async() => {
      try {
        let obj = await processExit({
          promise: Promise.reject(stderr),
          cwd,
          commitMessage,
          expect
        });

        resolve(obj);
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function processExit({
  promise,
  cwd,
  commitMessage,
  noGit,
  expect
}) {
  let obj;

  try {
    let result = await promise;

    obj = { result };
  } catch (stderr) {
    if (typeof stderr !== 'string') {
      throw stderr;
    }

    expect(stderr).to.not.contain('Error:');
    expect(stderr).to.not.contain('fatal:');
    expect(stderr).to.not.contain('Command failed');

    obj = { stderr };
  }

  if (!noGit) {
    let result = await git(['log', '-1'], {
      cwd
    });

    // verify it is not committed
    expect(result).to.contain('Author: Your Name <you@example.com>');
    expect(result).to.contain(commitMessage);

    result = await git(['branch'], {
      cwd
    });

    // verify branch was deleted
    expect(result.trim()).to.match(branchRegExp);

    let status = await gitStatus({
      cwd
    });

    obj.status = status;
  }

  return obj;
}

function fixtureCompare({
  expect,
  actual,
  expected
}) {
  actual = fixturify.readSync(actual, { ignoreEmptyDirs: true });
  expected = fixturify.readSync(expected);

  delete actual['.git'];
  delete actual['node_modules'];

  expect(actual).to.deep.equal(expected);
}

async function cloneRemote({
  localPath,
  remoteName = 'origin',
  remotePath
}) {
  if (!remotePath) {
    remotePath = await createTmpDir();
  }

  await git(['clone', '--bare', localPath, remotePath]);

  await git(['remote', 'add', remoteName, remotePath], {
    cwd: localPath
  });

  let branchNames = await getLocalBranchNames({
    cwd: localPath
  });

  for (let branchName of branchNames) {
    // await git(['set-upstream', 'add', remoteName, remotePath], {
    //   cwd: localPath
    // });
  }

  return remotePath;
}

async function getLocalBranchNames(options) {
  let stdout = await git(['for-each-ref', '--format', '%(refname:short)', 'refs/heads'], options);

  return toLines(stdout);
}

module.exports = {
  gitInit,
  commit,
  postCommit,
  buildTmp,
  processBin,
  processIo,
  processExit,
  fixtureCompare,
  cloneRemote
};
