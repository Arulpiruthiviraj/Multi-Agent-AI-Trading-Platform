import React from 'react';
import { MobileHealthLog } from '../MobileHealthLog';
import { MobileOpsConsole } from '../MobileOpsConsole';

export function MobileTerminalView() {
  return (
    <div className="space-y-4 p-3 pb-6">
      <MobileOpsConsole />
      <MobileHealthLog />
    </div>
  );
}
