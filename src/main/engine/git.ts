import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getCurrentProjectPath } from './project-store'
import { parseBranchList } from '../../shared/git-parse'

const exec = promisify(execFile)
const git = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
  exec('git', args, { cwd: getCurrentProjectPath(), timeout: 8000 })

export async function gitInfo(): Promise<{ isRepo: boolean; branch: string; dirty: boolean; branches: string[] }> {
  try {
    await git(['rev-parse', '--is-inside-work-tree'])
  } catch {
    return { isRepo: false, branch: '', dirty: false, branches: [] }
  }
  const [branch, status, branchList] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']).then((r) => r.stdout.trim()).catch(() => ''),
    git(['status', '--porcelain']).then((r) => r.stdout).catch(() => ''),
    git(['branch', '--format=%(refname:short)']).then((r) => r.stdout).catch(() => '')
  ])
  return { isRepo: true, branch, dirty: status.trim() !== '', branches: parseBranchList(branchList) }
}

export async function gitCheckout(branch: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { stdout } = await git(['status', '--porcelain'])
    if (stdout.trim() !== '') {
      return { ok: false, error: 'Working tree has uncommitted changes — commit or stash first.' }
    }
    await git(['checkout', branch])
    return { ok: true }
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr
    const msg = (stderr && stderr.trim()) || (err instanceof Error ? err.message : String(err))
    return { ok: false, error: String(msg).split('\n')[0].trim() || 'checkout failed' }
  }
}
