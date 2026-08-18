import React from 'react';
import { X } from 'lucide-react';

interface JsonDetailModalProps {
  open: boolean;
  title: string;
  data: unknown;
  onClose: () => void;
}

export function JsonDetailModal({ open, title, data, onClose }: JsonDetailModalProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[400] bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="bg-[#1A1F2B] border border-slate-700 rounded-t-2xl sm:rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <h3 className="text-xs font-mono uppercase tracking-widest text-white">{title}</h3>
          <button type="button" onClick={onClose} className="min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-400 hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <pre className="p-4 overflow-auto text-[10px] font-mono text-slate-300 flex-1 whitespace-pre-wrap break-all">
          {data == null ? '--' : JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </div>
  );
}
