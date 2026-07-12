import React, { useState, useEffect } from "react";
import { X, ChevronRight, ChevronLeft, LayoutDashboard, BrainCircuit, Activity, Sliders, ShieldCheck, Cpu } from "lucide-react";

interface Step {
  targetId: string;
  title: string;
  content: string;
  icon: React.ReactNode;
  position: "top" | "bottom" | "left" | "right";
}

const steps: Step[] = [
  {
    targetId: "tab-command-btn",
    title: "The Dashboard",
    content: "This is your command center. It displays your portfolio, market overview, AI confidence, current opportunities, profit/loss, and autonomous trading status.",
    icon: <LayoutDashboard className="text-emerald-400" size={16} />,
    position: "bottom"
  },
  {
    targetId: "tab-portfolio-btn",
    title: "Portfolio",
    content: "View all your holdings, unrealized profit/loss, portfolio allocation, and AI recommendations for each position.",
    icon: <Activity className="text-emerald-400" size={16} />,
    position: "bottom"
  },
  {
    targetId: "tab-scanner-btn",
    title: "Market Scanner",
    content: "This continuously scans the market looking for new opportunities using technical analysis, news, AI reasoning, and internal calculation engines.",
    icon: <Activity className="text-emerald-400" size={16} />,
    position: "bottom"
  },
  {
    targetId: "tab-agents-btn",
    title: "AI Agents",
    content: "This page shows how multiple AI models analyze the market independently before reaching a consensus.",
    icon: <BrainCircuit className="text-emerald-400" size={16} />,
    position: "bottom"
  },
  {
    targetId: "tab-validation-btn",
    title: "Calculation Engines",
    content: "Internal mathematical models calculate technical indicators, trend strength, volatility, and other market signals. These results are used as evidence by the AI agents.",
    icon: <Cpu className="text-emerald-400" size={16} />,
    position: "bottom"
  },
  {
    targetId: "tab-settings-btn",
    title: "Risk Settings",
    content: "Configure your risk limits, capital allocation, and broker connection before initializing autonomous trading.",
    icon: <Sliders className="text-emerald-400" size={16} />,
    position: "bottom"
  },
  {
    targetId: "init-auto-btn",
    title: "Mission Control",
    content: "Click this to watch autonomous trading operate in real time. See every worker, AI agent, and calculation engine collaborating to make trading decisions.",
    icon: <ShieldCheck className="text-emerald-400" size={16} />,
    position: "bottom"
  }
];

export const AppWalkthrough: React.FC = () => {
  const [isVisible, setIsVisible] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);

  useEffect(() => {
    const hasSeenTour = localStorage.getItem("argus_tour_seen");
    if (!hasSeenTour) {
      setTimeout(() => setShowWelcome(true), 1500);
    }
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    
    const updatePosition = () => {
      const el = document.getElementById(steps[currentStep].targetId);
      if (el) {
        setTargetRect(el.getBoundingClientRect());
        el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      } else {
        setTargetRect(null);
      }
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    
    // Attempt to update position periodically in case of layout shifts
    const interval = setInterval(updatePosition, 500);
    
    return () => {
      window.removeEventListener("resize", updatePosition);
      clearInterval(interval);
    };
  }, [currentStep, isVisible]);

  const startTour = () => {
    setShowWelcome(false);
    setIsVisible(true);
    setCurrentStep(0);
  };

  const skipTour = () => {
    setShowWelcome(false);
    setIsVisible(false);
    localStorage.setItem("argus_tour_seen", "true");
  };

  const viewLater = () => {
    setShowWelcome(false);
    setIsVisible(false);
  };

  if (showWelcome) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm pointer-events-auto" onClick={viewLater} />
        <div className="bg-[#1A1F2B] border border-indigo-500/50 shadow-[0_0_40px_rgba(99,102,241,0.2)] rounded-xl p-8 w-full max-w-md pointer-events-auto relative z-10 animate-fade-in text-center">
          <div className="w-16 h-16 bg-indigo-500/20 rounded-full flex items-center justify-center mx-auto mb-4 border border-indigo-500/30">
            <span className="text-3xl">👋</span>
          </div>
          <h2 className="text-xl font-bold text-white mb-2">Welcome to Autonomous AI Trading</h2>
          <p className="text-sm text-slate-400 mb-8 leading-relaxed">
            Would you like a guided walkthrough of the system architecture, AI agents, and risk guardrails?
          </p>
          <div className="flex flex-col gap-3">
            <button onClick={startTour} className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg transition-colors shadow-lg shadow-indigo-500/20">
              Start Tour
            </button>
            <div className="flex gap-3">
              <button onClick={skipTour} className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-lg transition-colors">
                Skip
              </button>
              <button onClick={viewLater} className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-lg transition-colors">
                Remind Me Later
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!isVisible) return null;

  const step = steps[currentStep];

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      skipTour();
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) setCurrentStep(currentStep - 1);
  };

  return (
    <div className="fixed inset-0 z-[100] pointer-events-none">
      <div className="absolute inset-0 bg-black/40 pointer-events-auto" onClick={skipTour} />
      
      {/* Target Highlight */}
      {targetRect && (
        <div 
          className="absolute border-2 border-indigo-500 rounded-lg shadow-[0_0_20px_rgba(99,102,241,0.4)] transition-all duration-500 pointer-events-none bg-indigo-500/10 backdrop-blur-sm"
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
        className="absolute bg-[#1A1F2B] border border-indigo-500/40 shadow-2xl rounded-xl p-5 w-80 pointer-events-auto transition-all duration-500 animate-fade-in flex flex-col"
        style={{
          ...(targetRect ? {
            top: step.position === 'bottom' ? targetRect.bottom + 16 : 
                 step.position === 'top' ? targetRect.top - 180 : 
                 targetRect.top + targetRect.height/2 - 80,
            left: step.position === 'right' ? targetRect.right + 16 : 
                  step.position === 'left' ? targetRect.left - 336 : 
                  Math.min(Math.max(16, targetRect.left + targetRect.width/2 - 160), window.innerWidth - 336),
          } : {
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)'
          })
        }}
      >
        <button onClick={skipTour} className="absolute top-3 right-3 text-slate-500 hover:text-white transition-colors">
          <X size={16} />
        </button>
        
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20">
            {step.icon}
          </div>
          <div>
            <div className="text-[10px] font-mono text-indigo-400 font-bold uppercase tracking-widest leading-none">
              Step {currentStep + 1} of {steps.length}
            </div>
            <h3 className="text-white font-bold text-sm leading-tight mt-1">{step.title}</h3>
          </div>
        </div>
        
        <p className="text-slate-300 text-xs leading-relaxed mb-6">
          {step.content}
        </p>

        <div className="flex justify-between items-center mt-auto">
          <button onClick={viewLater} className="text-slate-500 hover:text-white text-[10px] font-bold underline transition-colors">
            Exit Tour
          </button>
          
          <div className="flex gap-2">
            {currentStep > 0 && (
              <button onClick={handlePrev} className="p-1.5 bg-slate-800 text-slate-300 rounded hover:bg-slate-700 transition-colors">
                <ChevronLeft size={16} />
              </button>
            )}
            <button onClick={handleNext} className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded flex items-center gap-1 transition-colors">
              {currentStep === steps.length - 1 ? "Finish" : "Next"} <ChevronRight size={14} />
            </button>
          </div>
        </div>
        
        <div className="absolute bottom-[-16px] left-0 right-0 flex justify-center gap-1.5">
          {steps.map((_, idx) => (
             <div key={idx} className={`w-1.5 h-1.5 rounded-full ${idx === currentStep ? "bg-indigo-500" : "bg-slate-700"}`} />
          ))}
        </div>
      </div>
    </div>
  );
};
