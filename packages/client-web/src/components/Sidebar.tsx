import React from "react";
import { useSessionStore } from "../useSessionStore";
import { 
  Folder, 
  Terminal, 
  History, 
  Plus,
  Settings,
  MoreVertical,
  Activity
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function Sidebar() {
  const { 
    projections, 
    selectedSessionId, 
    setSelectedSessionId,
    storedSessions 
  } = useSessionStore();

  const sessions = Array.from(projections.values());

  return (
    <div className="w-72 bg-card border-r border-border flex flex-col h-full shadow-sm">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
          <div className="bg-primary text-primary-foreground p-1 rounded">
            <Activity size={18} />
          </div>
          RAH
        </div>
        <button className="p-1.5 hover:bg-muted rounded-md transition-colors border border-border/50 shadow-sm">
          <Plus size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-6">
        <div>
          <div className="px-3 mb-2 flex items-center justify-between">
             <span className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Active Sessions</span>
             <span className="bg-primary/10 text-primary text-[10px] px-1.5 py-0.5 rounded-full font-bold">
               {sessions.length}
             </span>
          </div>
          <div className="space-y-1">
            {sessions.map((p) => (
              <button
                key={p.summary.session.id}
                onClick={() => setSelectedSessionId(p.summary.session.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all group",
                  selectedSessionId === p.summary.session.id
                    ? "bg-primary text-primary-foreground shadow-md shadow-primary/20 font-medium"
                    : "hover:bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                <Terminal size={16} className={cn(
                  selectedSessionId === p.summary.session.id ? "text-primary-foreground" : "text-muted-foreground group-hover:text-primary"
                )} />
                <div className="flex-1 text-left truncate">
                  <div className="truncate">{p.summary.session.id.split('-')[0]}</div>
                  <div className={cn(
                    "text-[10px] truncate opacity-60",
                    selectedSessionId === p.summary.session.id ? "text-primary-foreground" : "text-muted-foreground"
                  )}>
                    {p.summary.session.provider} • {p.summary.session.runtimeState}
                  </div>
                </div>
              </button>
            ))}
            {sessions.length === 0 && (
              <div className="px-3 py-8 text-center border-2 border-dashed border-border rounded-xl">
                <p className="text-xs text-muted-foreground">No active sessions</p>
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="px-3 mb-2 flex items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">History</span>
          </div>
          <div className="space-y-1">
            {storedSessions.slice(0, 5).map((s) => (
              <button
                key={s.providerSessionId}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
              >
                <History size={16} />
                <div className="flex-1 text-left truncate">
                  <div className="truncate text-xs font-medium">{s.providerSessionId}</div>
                  <div className="text-[10px] truncate opacity-50">{s.rootDir || s.cwd}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="p-3 border-t border-border mt-auto">
        <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-all">
          <Settings size={16} />
          <span>Settings</span>
        </button>
      </div>
    </div>
  );
}
