/**
 * ==========================================================
 * Module:
 * ContextualTooltip.tsx
 *
 * Purpose:
 * Core implementation and logic for the ContextualTooltip.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for ContextualTooltipx
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import React, { useState } from 'react';
import { HelpCircle } from 'lucide-react';

interface ContextualTooltipProps {
  title: string;
  content: string;
  children?: React.ReactNode;
  showIcon?: boolean;
}

export function ContextualTooltip({ title, content, children, showIcon = true }: ContextualTooltipProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div className="relative inline-flex items-center group">
      {children}
      {showIcon && (
        <button 
          onMouseEnter={() => setIsHovered(true)} 
          onMouseLeave={() => setIsHovered(false)}
          className="ml-1.5 text-slate-500 hover:text-indigo-400 transition-colors focus:outline-none"
        >
          <HelpCircle size={14} />
        </button>
      )}
      
      {/* Tooltip Popup */}
      <div 
        className={`absolute z-50 w-64 p-3 bg-[#1A1F2B] border border-indigo-500/30 rounded-lg shadow-xl transition-all duration-200 pointer-events-none ${isHovered ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}
        style={{ bottom: '100%', left: '50%', transform: 'translateX(-50%) translateY(-8px)' }}
      >
        {/* Arrow */}
        <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-4 h-4 bg-[#1A1F2B] border-r border-b border-indigo-500/30 transform rotate-45"></div>
        
        <div className="relative z-10">
          <h4 className="text-xs font-bold text-white mb-1">{title}</h4>
          <p className="text-[10px] leading-relaxed text-slate-300">{content}</p>
        </div>
      </div>
    </div>
  );
}
