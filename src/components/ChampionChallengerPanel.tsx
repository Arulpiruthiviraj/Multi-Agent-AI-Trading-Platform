/**
 * Phase 4H (Controlled Self-Evolution) - version history, promotion decisions, and rollback
 * history for a learning-state versionType (GET /api/v2/continuous-intelligence/learning/versions).
 * No experimental version reaches CHAMPION without passing the promotion gate — this panel exists
 * to make that gate, and every rollback, fully auditable.
 */
import React, { useEffect, useRef, useState } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';

interface LearningVersion {
  id: string;
  versionType: string;
  parentVersionId: string | null;
  status: 'SHADOW' | 'CANDIDATE' | 'CHAMPION' | 'RETIRED' | 'ROLLED_BACK';
  hypothesis: string | null;
  sampleSize: number;
  createdAt: string;
  promotedAt: string | null;
  retiredAt: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  SHADOW: 'text-slate-500 border-slate-600/30 bg-slate-600/10',
  CANDIDATE: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  CHAMPION: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  RETIRED: 'text-slate-600 border-slate-700/30 bg-slate-700/10',
  ROLLED_BACK: 'text-rose-400 border-rose-500/30 bg-rose-500/10',
};

export default function ChampionChallengerPanel({ versionType }: { versionType: string }) {
  const [versions, setVersions] = useState<LearningVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch(`/api/v2/continuous-intelligence/learning/versions/${encodeURIComponent(versionType)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => { if (d.ok) { setVersions(d.versions || []); setError(null); } else setError(d.error || 'unknown error'); })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => { clearInterval(interval); abortRef.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionType]);

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <GitBranch size={14} className="text-amber-400" /> Champion / challenger: {versionType}
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            No version reaches CHAMPION without passing the sample-size + improvement-margin gate
          </p>
        </div>
        <button onClick={fetchData} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-400 text-[10px] uppercase tracking-widest font-bold rounded">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load version history: {error}</p>}

      {versions.length === 0 ? (
        <p className="text-[11px] text-slate-600">No learning versions recorded yet for this type.</p>
      ) : (
        <div className="space-y-1.5">
          {versions.map((v) => (
            <div key={v.id} className="border border-slate-800 rounded bg-[#111822] px-3 py-2">
              <div className="flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-2">
                  <span className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded border ${STATUS_COLOR[v.status]}`}>{v.status}</span>
                  <span className="text-slate-400 font-mono">{v.id}</span>
                </div>
                <span className="text-slate-500">n={v.sampleSize}</span>
              </div>
              {v.hypothesis && <p className="text-slate-500 text-[10px] mt-1">{v.hypothesis}</p>}
              <div className="flex gap-3 text-[9px] text-slate-600 mt-1">
                <span>Created {new Date(v.createdAt).toLocaleString()}</span>
                {v.promotedAt && <span className="text-emerald-500">Promoted {new Date(v.promotedAt).toLocaleString()}</span>}
                {v.retiredAt && <span>Retired {new Date(v.retiredAt).toLocaleString()}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
