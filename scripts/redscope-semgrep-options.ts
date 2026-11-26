export function validateSemgrepBaseline(commit: string | undefined, profile: string | undefined) {
  if (commit === undefined) return
  if (profile !== 'authorized-semgrep-sast') {
    throw new Error('--semgrep-baseline requires the authorized-semgrep-sast repository profile')
  }
  if ((commit.length !== 40 && commit.length !== 64) || /[^0-9a-f]/i.test(commit)) {
    throw new Error('--semgrep-baseline requires a full 40- or 64-character hexadecimal Git commit SHA')
  }
}
