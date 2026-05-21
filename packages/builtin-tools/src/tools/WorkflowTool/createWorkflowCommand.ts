import { readdir } from 'fs/promises'
import { join, parse } from 'path'
import type { Command } from 'src/types/command.js'
import { WORKFLOW_DIR_NAMES, WORKFLOW_FILE_EXTENSIONS } from './constants.js'

/**
 * Scans .redscope/workflows/ and .claude/workflows/ directories and creates Command objects for each workflow file.
 * Each workflow file becomes a slash command (e.g. /workflow-name).
 */
export async function getWorkflowCommands(cwd: string): Promise<Command[]> {
  const commands: Command[] = []
  const seen = new Set<string>()

  for (const dirName of WORKFLOW_DIR_NAMES) {
    const workflowDir = join(cwd, dirName)
    let files: string[]
    try {
      files = await readdir(workflowDir)
    } catch {
      continue
    }

    const workflowFiles = files.filter((f) => {
      const ext = parse(f).ext.toLowerCase()
      return WORKFLOW_FILE_EXTENSIONS.includes(ext)
    })

    for (const file of workflowFiles) {
      const name = parse(file).name
      if (seen.has(name)) continue
      seen.add(name)
      commands.push({
        type: 'prompt' as const,
        name,
        description: `Run workflow: ${name}`,
        kind: 'workflow' as const,
        source: 'builtin' as const,
        progressMessage: `Running workflow ${name}...`,
        contentLength: 0,
        async getPromptForCommand(args, _context) {
          const { readFile } = await import('fs/promises')
          const content = await readFile(join(workflowDir, file), 'utf-8')
          return [
            {
              type: 'text' as const,
              text: `Execute this workflow:\n\n${content}${args ? `\n\nArguments: ${args}` : ''}`,
            },
          ]
        },
      } satisfies Command)
    }
  }

  return commands
}
