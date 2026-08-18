import React, { type ReactElement, type ReactNode } from 'react';
import { ContextualTooltip } from '../ContextualTooltip';
import type { AppTabId, NavDomain } from './responsiveNavConfig';
import type { MobileTabId } from '../mobile/mobileTabs';
import {
  MOBILE_TAB_TOOLTIPS,
  NAV_DOMAIN_TOOLTIPS,
  NAV_TAB_TOOLTIPS,
  type NavTooltipCopy,
} from './navTabTooltips';

type NavTabTooltipProps = {
  copy: NavTooltipCopy;
  children: ReactNode;
  className?: string;
};

function TooltipShell({ copy, children, className }: NavTabTooltipProps): ReactElement {
  return (
    <ContextualTooltip
      title={copy.title}
      content={copy.purpose}
      showIcon={false}
      quiet
      wrapTrigger
      alwaysShow
      compact
      className={className ?? 'inline-flex max-w-full'}
      showDelayMs={180}
    >
      {children}
    </ContextualTooltip>
  );
}

export function NavTabTooltip({
  tabId,
  children,
  className,
}: {
  tabId: AppTabId;
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <TooltipShell copy={NAV_TAB_TOOLTIPS[tabId]} className={className}>
      {children}
    </TooltipShell>
  );
}

export function NavDomainTooltip({
  domain,
  children,
  className,
}: {
  domain: NavDomain | 'more';
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <TooltipShell copy={NAV_DOMAIN_TOOLTIPS[domain]} className={className ?? 'flex flex-1'}>
      {children}
    </TooltipShell>
  );
}

export function MobileNavTabTooltip({
  tabId,
  children,
  className,
}: {
  tabId: MobileTabId;
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <TooltipShell copy={MOBILE_TAB_TOOLTIPS[tabId]} className={className ?? 'flex flex-1'}>
      {children}
    </TooltipShell>
  );
}
