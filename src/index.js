'use strict';

const path = require('path');
const fs = require('fs-extra');
const cp = require('child_process');
const fixturify = require('fixturify');
const { promisify } = require('util');
const tmpDir = promisify(require('tmp').dir);
const {
  run,
  gitInit: _gitInit,
  gitStatus,
  isGitClean,
  gitRemoveAll
} = require('git-diff-apply');

const branchName = 'foo';
const branchRegExp = new RegExp(`^\\* ${branchName}\\r?\\n {2}master$`);

async function gitInit({
  cwd
}) {
  _gitInit({
    cwd
  });

  run('git config merge.tool "vimdiff"', {
    cwd
  });

  run('git config mergetool.keepBackup false', {
    cwd
  });
}

async function commit({
  m = 'initial commit',
  tag,
  cwd
}) {
  run('git add -A', {
    cwd
  });

  // allow no changes between tags
  if (!isGitClean({
    cwd
  })) {
    run(`git commit -m "${m}"`, {
      cwd
    });
  }

  if (tag) {
    run(`git tag ${tag}`, {
      cwd
    });
  }
}

async function postCommit({
  cwd,
  dirty
}) {
  // non-master branch test
  run(`git checkout -b ${branchName}`, {
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
  let tmpPath = await tmpDir();

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

    await fs.copy(path.join(fixturesPath, tag), tmpSubPath);

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
  args = [],
  cwd,
  commitMessage,
  expect
}) {
  binFile = path.join(process.cwd(), 'bin', binFile);

  args = [binFile].concat(args);

  let ps = cp.spawn('node', args, {
    cwd,
    env: process.env
  });

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
  return await new Promise(resolve => {
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
      resolve(await processExit({
        promise: Promise.reject(stderr),
        cwd,
        commitMessage,
        expect
      }));
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
    let result = run('git log -1', {
      cwd
    });

    // verify it is not committed
    expect(result).to.contain('Author: Your Name <you@example.com>');
    expect(result).to.contain(commitMessage);

    result = run('git branch', {
      cwd
    });

    // verify branch was deleted
    expect(result.trim()).to.match(branchRegExp);

    let status = gitStatus({
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

module.exports = {
  gitInit,
  commit,
  postCommit,
  buildTmp,
  processBin,
  processIo,
  processExit,
  fixtureCompare
};
