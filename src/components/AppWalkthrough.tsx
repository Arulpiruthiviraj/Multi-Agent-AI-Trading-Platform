import React, { useState, useEffect } from "react";
import { X, ChevronRight, ChevronLeft } from "lucide-react";

interface Step {
  targetId: string;
  title: string;
  content: string;
  position: "top" | "bottom" | "left" | "right";
}

const steps: Step[] = [
  {
    targetId: "tab-command-btn",
    title: "Step 1: The Dashboard",
    content: "Here you can monitor market conditions, active trades, AI decisions, and portfolio performance.",
    position: "bottom"
  },
  {
    targetId: "market-data-panel",
    title: "Step 2: Market Indicators",
    content: "These indicators show the current market condition calculated by your Quant Engine. It's objective mathematical data.",
    position: "right"
  },
  {
    targetId: "agent-council-panel",
    title: "Step 3: AI Agent Panel",
    content: "Multiple AI agents analyze the market independently and provide opinions. They debate and find consensus before any action is taken.",
    position: "left"
  },
  {
    targetId: "risk-guardrails-panel",
    title: "Step 4: Risk & Execution",
    content: "Before any trade happens, the Risk Engine validates the trade to ensure it fits your safety parameters.",
    position: "top"
  }
];

export const AppWalkthrough: React.FC = () => {
  const [isVisible, setIsVisible] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    // Check if user has seen tour
    const hasSeenTour = localStorage.getItem("argus_tour_seen");
    if (!hasSeenTour) {
      setTimeout(() => setIsVisible(true), 1500); // Slight delay for initial load
    }
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    
    const updatePosition = () => {
      const el = document.getElementById(steps[currentStep].targetId);
      if (el) {
        setTargetRect(el.getBoundingClientRect());
      } else {
        // Fallback to center screen if element not found yet
        setTargetRect(null);
      }
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [currentStep, isVisible]);

  if (!isVisible) return null;

  const step = steps[currentStep];

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      closeTour();
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) setCurrentStep(currentStep - 1);
  };

  const closeTour = () => {
    setIsVisible(false);
    localStorage.setItem("argus_tour_seen", "true");
  };

  const viewLater = () => {
    setIsVisible(false);
  };

  return (
    <div className="fixed inset-0 z-[100] pointer-events-none">
      <div className="absolute inset-0 bg-black/40 pointer-events-auto" onClick={closeTour} />
      
      {/* Target Highlight */}
      {targetRect && (
        <div 
          className="absolute border-2 border-emerald-500 rounded-lg shadow-[0_0_20px_rgba(16,185,129,0.4)] transition-all duration-500 pointer-events-none"
          style={{
            top: targetRect.top - 8,
            left: targetRect.left - 8,
            width: targetRect.width + 16,
            height: targetRect.height + 16,
          }}
        />
      )}

      {/* Tooltip Dialog */}
      <div 
        className="absolute bg-[#1A1F2B] border border-slate-700 shadow-2xl rounded-lg p-5 w-80 pointer-events-auto transition-all duration-500 animate-fade-in"
        style={{
          ...(targetRect ? {
            top: step.position === 'bottom' ? targetRect.bottom + 16 : 
                 step.position === 'top' ? targetRect.top - 180 : 
                 targetRect.top + targetRect.height/2 - 80,
            left: step.position === 'right' ? targetRect.right + 16 : 
                  step.position === 'left' ? targetRect.left - 336 : 
                  targetRect.left + targetRect.width/2 - 160,
          } : {
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)'
          })
        }}
      >
        <button onClick={closeTour} className="absolute top-3 right-3 text-slate-500 hover:text-white transition-colors">
          <X size={16} />
        </button>
        
        <div className="text-[10px] font-mono text-emerald-400 font-bold uppercase tracking-widest mb-2">
          Welcome to AI Trading Assistant
        </div>
        <h3 className="text-white font-bold text-sm mb-2">{step.title}</h3>
        <p className="text-slate-300 text-xs leading-relaxed mb-6">
          {step.content}
        </p>

        <div className="flex justify-between items-center">
          <button onClick={viewLater} className="text-slate-500 hover:text-white text-[10px] font-bold underline transition-colors">
            View Later
          </button>
          
          <div className="flex gap-2">
            {currentStep > 0 && (
              <button onClick={handlePrev} className="p-1.5 bg-slate-800 text-slate-300 rounded hover:bg-slate-700 transition-colors">
                <ChevronLeft size={16} />
              </button>
            )}
            <button onClick={handleNext} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded flex items-center gap-1 transition-colors">
              {currentStep === steps.length - 1 ? "Finish" : "Next"} <ChevronRight size={14} />
            </button>
          </div>
        </div>
        
        <div className="absolute bottom-[-10px] left-0 right-0 flex justify-center gap-1.5">
          {steps.map((_, idx) => (
             <div key={idx} className={`w-1.5 h-1.5 rounded-full ${idx === currentStep ? "bg-emerald-500" : "bg-slate-700"}`} />
          ))}
        </div>
      </div>
    </div>
  );
};
