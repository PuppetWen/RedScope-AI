import { describe, expect, test } from 'bun:test'
import {
  BASH_CLASSIFIER_DISABLED_REASON,
  classifyBashCommand,
  createPromptRuleContent,
  extractPromptDescription,
  generateGenericDescription,
  getBashPromptAllowDescriptions,
  getBashPromptAskDescriptions,
  getBashPromptDenyDescriptions,
  isClassifierPermissionsEnabled,
} from '../bashClassifier.js'

describe('bashClassifier RedScope external boundary', () => {
  test('keeps semantic Bash classifier permissions disabled', () => {
    expect(isClassifierPermissionsEnabled()).toBe(false)
    expect(getBashPromptAllowDescriptions({})).toEqual([])
    expect(getBashPromptAskDescriptions({})).toEqual([])
    expect(getBashPromptDenyDescriptions({})).toEqual([])
  })

  test('does not parse prompt rule descriptions while disabled', () => {
    expect(createPromptRuleContent('  run read-only git commands  ')).toBe(
      'prompt: run read-only git commands',
    )
    expect(extractPromptDescription('prompt: run read-only git commands')).toBe(
      null,
    )
  })

  test('returns a stable no-match classifier result', async () => {
    const result = await classifyBashCommand(
      'git status',
      process.cwd(),
      ['allow read-only git commands'],
      'allow',
      new AbortController().signal,
      true,
    )

    expect(result).toEqual({
      matches: false,
      confidence: 'high',
      reason: BASH_CLASSIFIER_DISABLED_REASON,
    })
  })

  test('preserves explicit descriptions without generating new semantic text', async () => {
    await expect(
      generateGenericDescription(
        'git status',
        'Inspect repository status',
        new AbortController().signal,
      ),
    ).resolves.toBe('Inspect repository status')
    await expect(
      generateGenericDescription(
        'git status',
        undefined,
        new AbortController().signal,
      ),
    ).resolves.toBeNull()
  })
})
