import React from 'react';
import { X } from 'lucide-react';

interface MobileBottomSheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  danger?: boolean;
}

export function MobileBottomSheet({ open, title, onClose, children, danger }: MobileBottomSheetProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[300] flex flex-col justify-end" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <button type="button" className="absolute inset-0 bg-black/60" aria-label="Close sheet" onClick={onClose} />
      <div className={`relative bg-[#1A1F2B] border-t rounded-t-2xl p-4 max-h-[85vh] overflow-y-auto ${danger ? 'border-rose-500/40' : 'border-slate-700'}`}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold uppercase tracking-widest text-white font-mono">{title}</h2>
          <button type="button" onClick={onClose} className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-400" aria-label="Close">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
