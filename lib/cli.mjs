import { realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { UserError, windows } from './storage.mjs';

const commands = { codex: 'codex', antigravity: 'agy' };
const authVariables = {
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
  antigravity: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AGY_ADC_AUTH']
};

export function canLaunch(account) {
  return process.platform === 'win32' && (account.kind === 'oauth' || account.provider !== 'antigravity');
}

async function cliExecutable(provider) {
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(delimiter)
    .filter(extension => ['.com', '.exe', '.bat', '.cmd'].includes(extension));
  for (const entry of (process.env.PATH || '').split(delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = join(directory, commands[provider] + extension);
      if ((await stat(candidate).catch(() => null))?.isFile()) return candidate;
    }
  }
  if (provider !== 'antigravity') return '';
  // A newly installed CLI may not be on the workbench process's PATH yet.
  for (const directory of [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'agy', 'bin'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google', 'antigravity-cli')].filter(Boolean)) {
    const candidate = join(directory, 'agy.exe');
    if ((await stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  return '';
}

export async function prepareCli(account, directory) {
  if (!canLaunch(account)) throw new UserError('此账号无法用于终端启动');
  const executable = await cliExecutable(account.provider);
  if (!executable) throw new UserError('找不到 ' + commands[account.provider] + '，请将客户端 CLI 加入 PATH');
  let cwd;
  try {
    cwd = await realpath(typeof directory === 'string' && directory.trim() ? directory.trim() : process.cwd());
    if (!(await stat(cwd)).isDirectory()) throw new Error();
  } catch { throw new UserError('找不到项目目录'); }
  const env = { ...process.env, LOCAL_WORKSPACE_CLI: executable };
  for (const name of authVariables[account.provider]) delete env[name];
  if (account.kind === 'key') env[authVariables[account.provider][0]] = account.key;
  return { cwd, env };
}

export async function openCli(options) {
  await windows('open-cli', '', options).catch(() => { throw new UserError('无法启动终端'); });
}
