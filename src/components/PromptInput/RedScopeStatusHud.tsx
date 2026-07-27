import * as React from 'react';
import { useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import {
  buildRedscopeCompactStatusRows,
  buildRedscopeStatusRows,
  getRedscopeStatusModel,
  type RedscopeStatusModel,
  type RedscopeStatusRow,
  type StatusTone,
} from '../../utils/redscopeStatus.js';

const STATUS_REFRESH_MS = 3000;
const DETAILED_BREAKPOINT = 132;
const STACKED_BREAKPOINT = 96;

const TONE_COLOR: Record<StatusTone, 'suggestion' | 'success' | 'warning' | 'error' | undefined> = {
  goal: 'suggestion',
  ok: 'success',
  warn: 'warning',
  danger: 'error',
  active: 'suggestion',
  dim: undefined,
};

/**
 * Keep file-backed RedScope state out of the prompt's keystroke render path.
 * PromptInput re-renders on every character; polling here makes those reads
 * predictable while still reflecting new recon/egress/PoC snapshots quickly.
 */
function useRedscopeStatusModel(): RedscopeStatusModel {
  const [model, setModel] = useState(() => getRedscopeStatusModel());

  useEffect(() => {
    const refresh = () => setModel(getRedscopeStatusModel());
    const id = setInterval(refresh, STATUS_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  return model;
}

function hasDisplayableStatus(model: RedscopeStatusModel): boolean {
  return (
    model.engagement.present ||
    model.egress.configured ||
    (model.poc.present && model.poc.total > 0) ||
    model.firstRun.needed ||
    model.firstRun.proxyCount > 0 ||
    model.nuclei !== null
  );
}

function getHeaderHint(model: RedscopeStatusModel): string {
  const activeTargets = model.engagement.activeTargets.length;
  if (model.autonomy.available && activeTargets > 0) {
    return `AUTONOMY · ${activeTargets} TARGET${activeTargets === 1 ? '' : 'S'} ACTIVE`;
  }
  if (model.autonomy.available) return 'AUTONOMY ACTIVE';
  if (activeTargets > 0) {
    return `RECON LIVE · ${activeTargets} TARGET${activeTargets === 1 ? '' : 'S'}`;
  }
  if (model.engagement.present) return 'RECON LIVE';
  if (model.firstRun.needed) return 'SETUP PENDING';
  return 'SECURITY CONSOLE';
}

function StatusRow({
  row,
  labelWidth,
  stacked = false,
}: {
  row: RedscopeStatusRow;
  labelWidth: number;
  stacked?: boolean;
}): React.ReactNode {
  const color = TONE_COLOR[row.tone];
  if (stacked) {
    return (
      <Box flexDirection="column" width="100%">
        <Text color={color} dimColor={row.tone === 'dim'} bold>
          {row.icon} {row.label}
        </Text>
        <Box paddingLeft={2} width="100%">
          <Text color={color} dimColor={row.tone === 'dim'}>
            {row.value}
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" width="100%" height={1} overflow="hidden" gap={1}>
      <Box width={labelWidth} flexShrink={0}>
        <Text color={color} dimColor={row.tone === 'dim'} bold={row.tone === 'danger' || row.tone === 'active'}>
          {row.icon} {row.label}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate" color={color} dimColor={row.tone === 'dim'}>
          {row.value}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * High-signal RedScope panel embedded in the conversation input area.
 *
 * <132 columns: grouped rows preserve width and viewport height.
 * >=132 columns: detailed subsystem rows use two columns.
 */
export function RedScopeStatusHud(): React.ReactNode {
  const model = useRedscopeStatusModel();
  const { columns } = useTerminalSize();

  if (!hasDisplayableStatus(model)) return null;

  const detailed = columns >= DETAILED_BREAKPOINT;
  const rows = detailed
    ? buildRedscopeStatusRows(model).filter(row => row.id !== 'goal')
    : buildRedscopeCompactStatusRows(model);
  if (rows.length === 0) return null;

  const hasDanger = rows.some(row => row.tone === 'danger');
  const hasWarn = rows.some(row => row.tone === 'warn');
  const borderColor = hasDanger ? 'error' : hasWarn ? 'warning' : model.autonomy.available ? 'success' : 'suggestion';

  const midpoint = detailed ? Math.ceil(rows.length / 2) : rows.length;
  const leftRows = rows.slice(0, midpoint);
  const rightRows = detailed ? rows.slice(midpoint) : [];
  const labelWidth = detailed ? 16 : 13;
  const stacked = columns < STACKED_BREAKPOINT;
  const outerPadding = columns >= 48 ? 2 : 0;
  const panelInnerWidth = Math.max(20, columns - outerPadding * 2 - 4);
  const columnGap = 3;
  const leftColumnWidth = Math.floor((panelInnerWidth - columnGap) / 2);
  const rightColumnWidth = panelInnerWidth - columnGap - leftColumnWidth;

  return (
    <Box marginTop={1} paddingX={outerPadding} width="100%">
      <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column" width="100%">
        <Box width="100%" height={1} overflow="hidden">
          <Box flexShrink={1}>
            <Text color={borderColor} bold>
              ◆ REDSCOPE
            </Text>
            <Text dimColor> {getHeaderHint(model)}</Text>
          </Box>
        </Box>

        {detailed ? (
          <Box flexDirection="row" width={panelInnerWidth} gap={columnGap}>
            <Box flexDirection="column" width={leftColumnWidth}>
              {leftRows.map(row => (
                <StatusRow key={row.id} row={row} labelWidth={labelWidth} />
              ))}
            </Box>
            <Box flexDirection="column" width={rightColumnWidth}>
              {rightRows.map(row => (
                <StatusRow key={row.id} row={row} labelWidth={labelWidth} />
              ))}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            {leftRows.map(row => (
              <StatusRow key={row.id} row={row} labelWidth={labelWidth} stacked={stacked} />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
