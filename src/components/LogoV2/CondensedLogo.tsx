import * as React from 'react';
import { type ReactNode, useEffect } from 'react';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box } from '@anthropic/ink';
import { useAppState } from '../../state/AppState.js';
import { getEffortSuffix } from '../../utils/effort.js';
import { truncate } from '../../utils/format.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import {
  calculateCondensedLogoLayout,
  calculateInfoPillValueWidth,
  calculateInfoPillWidth,
  formatModelAndBilling,
  getLogoDisplayData,
  truncatePath,
} from '../../utils/logoV2Utils.js';
import { renderModelSetting } from '../../utils/model/model.js';
import { OffscreenFreeze } from '../OffscreenFreeze.js';
import { AnimatedClawd } from './AnimatedClawd.js';
import { Clawd } from './Clawd.js';
import { InfoPill, InfoPillRow } from './InfoPill.js';
import { GuestPassesUpsell, incrementGuestPassesSeenCount, useShowGuestPassesUpsell } from './GuestPassesUpsell.js';
import {
  incrementOverageCreditUpsellSeenCount,
  OverageCreditUpsell,
  useShowOverageCreditUpsell,
} from './OverageCreditUpsell.js';

export function CondensedLogo(): ReactNode {
  const { columns } = useTerminalSize();
  const agent = useAppState(s => s.agent);
  const effortValue = useAppState(s => s.effortValue);
  const model = useMainLoopModel();
  const modelDisplayName = renderModelSetting(model);
  const { version, cwd, billingType, agentName: agentNameFromSettings } = getLogoDisplayData();

  // Prefer AppState.agent (set from --agent CLI flag) over settings
  const agentName = agent ?? agentNameFromSettings;
  const showGuestPassesUpsell = useShowGuestPassesUpsell();
  const showOverageCreditUpsell = useShowOverageCreditUpsell();

  useEffect(() => {
    if (showGuestPassesUpsell) {
      incrementGuestPassesSeenCount();
    }
  }, [showGuestPassesUpsell]);

  useEffect(() => {
    if (showOverageCreditUpsell && !showGuestPassesUpsell) {
      incrementOverageCreditUpsellSeenCount();
    }
  }, [showOverageCreditUpsell, showGuestPassesUpsell]);

  const { direction, textWidth } = calculateCondensedLogoLayout(columns);

  // Truncate version to fit within the complete "[RedScope: v...]" pill.
  const versionValueWidth = calculateInfoPillValueWidth(textWidth, 'RedScope');
  const truncatedVersion = truncate(version, Math.max(versionValueWidth - 1, 1));

  const effortSuffix = getEffortSuffix(model, effortValue);
  const { shouldSplit, truncatedModel, truncatedBilling } = formatModelAndBilling(
    modelDisplayName + effortSuffix,
    billingType,
    textWidth,
  );

  const truncatedAgentName = agentName
    ? truncate(`@${agentName}`, calculateInfoPillValueWidth(textWidth, 'agent'))
    : undefined;

  // Truncate path, accounting for bracketed labels and optional agent pill.
  const usedAgentWidth = truncatedAgentName ? calculateInfoPillWidth('agent', truncatedAgentName) + 1 : 0;
  const cwdAvailableWidth = agentName ? textWidth - usedAgentWidth : textWidth;
  const truncatedCwd = truncatePath(cwd, calculateInfoPillValueWidth(cwdAvailableWidth, 'cwd'));

  // OffscreenFreeze: the logo sits at the top of the message list and is the
  // first thing to enter scrollback. useMainLoopModel() subscribes to model
  // changes and getLogoDisplayData() reads getCwd()/subscription state — any
  // of which changing while in scrollback would force a full terminal reset.
  return (
    <OffscreenFreeze>
      <Box flexDirection={direction} gap={direction === 'row' ? 2 : 1} alignItems="center">
        {isFullscreenEnvEnabled() ? <AnimatedClawd /> : <Clawd />}

        {/* Info */}
        <Box flexDirection="column" width={textWidth}>
          <InfoPillRow>
            <InfoPill label="RedScope" color="claude">
              v{truncatedVersion}
            </InfoPill>
          </InfoPillRow>
          {shouldSplit ? (
            <>
              <InfoPillRow>
                <InfoPill label="model" color="success">
                  {truncatedModel}
                </InfoPill>
              </InfoPillRow>
              <InfoPillRow>
                <InfoPill label="billing" color="warning">
                  {truncatedBilling}
                </InfoPill>
              </InfoPillRow>
            </>
          ) : (
            <InfoPillRow>
              <InfoPill label="model" color="success">
                {truncatedModel}
              </InfoPill>
              <InfoPill label="billing" color="warning">
                {truncatedBilling}
              </InfoPill>
            </InfoPillRow>
          )}
          <InfoPillRow>
            {truncatedAgentName && (
              <InfoPill label="agent" color="permission">
                {truncatedAgentName}
              </InfoPill>
            )}
            <InfoPill label="cwd" color="inactive">
              {truncatedCwd}
            </InfoPill>
          </InfoPillRow>
          {showGuestPassesUpsell && <GuestPassesUpsell />}
          {!showGuestPassesUpsell && showOverageCreditUpsell && <OverageCreditUpsell maxWidth={textWidth} twoLine />}
        </Box>
      </Box>
    </OffscreenFreeze>
  );
}
