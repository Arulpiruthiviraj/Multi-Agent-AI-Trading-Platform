/**
 * ==========================================================
 * Module: VectorClusteringMap
 *
 * This used to render 12 hardcoded "historical crisis" data points (2008 Financial Crisis,
 * COVID-19 Crash, etc.) at fixed, invented t-SNE coordinates - a permanently static scatter plot
 * with no real embedding computation behind it at all.
 *
 * No real embeddings/vector-store infrastructure exists anywhere in this codebase (no
 * pgvector/faiss/embedding-model dependency, confirmed via package.json and repo-wide search) -
 * building a real one is a genuine future feature, not a small incremental fix. Per the UI Truth
 * Principle, this now honestly discloses that rather than fabricating a plausible-looking chart.
 * ==========================================================
 */

import React from 'react';
import { Layers } from 'lucide-react';
import AwaitingSignal from './shared/AwaitingSignal';

export default function VectorClusteringMap() {
  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col h-full">
      <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-1.5 uppercase tracking-wide">
        <Layers size={16} className="text-purple-400" />
        Vector Space Clustering (t-SNE)
      </h3>
      <p className="text-xs text-slate-400 mb-6 leading-relaxed font-mono">
        No embedding model or vector store is wired. This is not a 2D projection of real event embeddings.
      </p>

      <div className="flex-1 w-full min-h-[300px] flex items-center justify-center">
        <AwaitingSignal
          label="Vector Clustering"
          reason="Not yet implemented - no real embedding model or vector store is wired into this codebase. Building one is a real future feature, not a small fix."
        />
      </div>
    </div>
  );
}
