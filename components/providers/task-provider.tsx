"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode, useRef } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Modal, Meter, Button, Led } from "@/components/ui";

interface TaskProgress {
  totalNodes: number;
  completedNodes: number;
  successNodes: number;
  failedNodes: number;
  logs: string[];
  labels?: {
    total?: string;
    success?: string;
    failed?: string;
    /** Show "done / total" in the first figure instead of the total alone. */
    showCompleted?: boolean;
  };
}

interface TaskContextType {
  isTaskRunning: boolean;
  isModalOpen: boolean;
  setIsModalOpen: (open: boolean) => void;
  progress: TaskProgress | null;
  startBulkTask: (nodeIds: number[], payload: Record<string, unknown>) => Promise<void>;
  runGenericTask: (
    totalSteps: number,
    initialLogs: string[],
    taskFn: (
      log: (msg: string) => void,
      progress: (completed: number, success: number, failed: number, newTotalSteps?: number) => void
    ) => Promise<void>,
    labels?: { total?: string; success?: string; failed?: string; showCompleted?: boolean; }
  ) => Promise<boolean>;
}

const TaskContext = createContext<TaskContextType | undefined>(undefined);

export function TaskProvider({ children }: { children: ReactNode }) {
  const [isTaskRunning, setIsTaskRunning] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [progress, setProgress] = useState<TaskProgress | null>(null);

  const terminalRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the terminal well on new logs
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [progress?.logs]);

  const startBulkTask = async (nodeIds: number[], payload: Record<string, unknown>) => {
    if (isTaskRunning) return;
    setIsTaskRunning(true);
    setIsModalOpen(true);

    setProgress({
      totalNodes: nodeIds.length,
      completedNodes: 0,
      successNodes: 0,
      failedNodes: 0,
      logs: [`Initiating global queue for ${nodeIds.length} node(s)...`, `Payload: ${JSON.stringify(payload)}`]
    });

    let sCount = 0;
    let fCount = 0;

    for (let i = 0; i < nodeIds.length; i++) {
      const id = nodeIds[i];
      try {
        const res = await fetch(`/api/sites/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          sCount++;
          toast.success(`Node ${id} payload fully synchronized.`);
          setProgress(p => p ? { ...p, successNodes: sCount, completedNodes: i + 1, logs: [...p.logs, `SUCCESS: Node ${id} overrides mapped securely.`] } : null);
        } else {
          fCount++;
          const err = await res.json().catch(() => ({}));
          toast.error(err.error || `Node ${id} rejected override.`);
          setProgress(p => p ? { ...p, failedNodes: fCount, completedNodes: i + 1, logs: [...p.logs, `ERROR: Node ${id} rejected override.`] } : null);
        }

        // Trigger global log reload for Notification Bell implicitly
        window.dispatchEvent(new Event("system_logs_updated"));

        if (i < nodeIds.length - 1) {
          setProgress(p => p ? { ...p, logs: [...p.logs, `Awaiting exact 35s hardware compilation lock...`] } : null);
          await new Promise(r => setTimeout(r, 35000));
        }
      } catch {
        fCount++;
        setProgress(p => p ? { ...p, failedNodes: fCount, completedNodes: i + 1, logs: [...p.logs, `FATAL: Network binding fault on Node ${id}.`] } : null);
      }
    }

    setProgress(p => p ? { ...p, logs: [...p.logs, `Queue Exhausted. ${sCount} Success, ${fCount} Failed.`] } : null);
    setIsTaskRunning(false);

    if (sCount > 0) {
      toast.success(`Applied changes to ${sCount} server(s).`);
      // Notify mounted data grids so they can update their optimistic arrays
      window.dispatchEvent(new CustomEvent("bulk_task_completed", { detail: { ids: nodeIds, payload } }));
    }
  };

  const runGenericTask = async (
    totalSteps: number,
    initialLogs: string[],
    taskFn: (
      log: (msg: string) => void,
      updateProgress: (completed: number, success: number, failed: number, newTotalSteps?: number) => void
    ) => Promise<void>,
    labels?: { total?: string; success?: string; failed?: string; showCompleted?: boolean; }
  ) => {
    if (isTaskRunning) return false;
    setIsTaskRunning(true);
    setIsModalOpen(true);

    setProgress({
      totalNodes: totalSteps,
      completedNodes: 0,
      successNodes: 0,
      failedNodes: 0,
      logs: initialLogs,
      labels
    });

    const addLog = (msg: string) => {
      // Embed explicitly locked local time into the trace immediately!
      const timeStr = `[${new Date().toLocaleTimeString()}] `;
      setProgress(p => p ? { ...p, logs: [...p.logs, `${timeStr}${msg}`] } : null);
    };

    // Mirror what the task reports, so the closing line can state the outcome
    // instead of assuming one. Reading it back off React state here would race
    // the last setProgress.
    const tally = { completed: 0, failed: 0, total: totalSteps };

    const updateProgress = (completed: number, success: number, failed: number, newTotalSteps?: number) => {
      tally.completed = completed;
      tally.failed = failed;
      if (newTotalSteps !== undefined) tally.total = newTotalSteps;

      setProgress(p => p ? {
        ...p,
        completedNodes: completed,
        successNodes: success,
        failedNodes: failed,
        totalNodes: newTotalSteps !== undefined ? newTotalSteps : p.totalNodes
      } : null);
    };

    try {
      await taskFn(addLog, updateProgress);

      // Do not log a blanket success or raise a success toast regardless of
      // what the task reported: a sync that read only some of its sites would
      // close looking like a clean run. All the runner actually knows is that taskFn returned without throwing, so
      // say that and quote the counters the task set.
      const shortfall = tally.total > 0 && tally.completed < tally.total;

      if (tally.total > 0) {
        addLog(
          `Run finished — ${tally.completed} of ${tally.total} completed, ${tally.failed} error(s).`
        );
      } else {
        addLog(`Run finished.`);
      }

      if (tally.failed > 0 || shortfall) {
        addLog(`Finished with gaps. Read the lines above before treating this as done.`);
        toast.warning(`Background process finished with gaps — check the log.`);
      } else {
        toast.success(`Background process finished.`);
      }
      return true;
    } catch (err) {
      addLog(`FATAL ERROR: ${err instanceof Error ? err.message : String(err)}`);
      toast.error(`Background task failed.`);
      return false;
    } finally {
      setIsTaskRunning(false);
      window.dispatchEvent(new Event("system_logs_updated"));
    }
  };

  const pct = progress && progress.totalNodes > 0
    ? Math.round((progress.completedNodes / progress.totalNodes) * 100)
    : 0;

  return (
    <TaskContext.Provider value={{ isTaskRunning, isModalOpen, setIsModalOpen, progress, startBulkTask, runGenericTask }}>
      {children}

      {/* Global task queue modal */}
      {progress && (
        <Modal
          open={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          title="Deployment queue"
          meta={isTaskRunning ? "running" : "settled"}
        >
          <div className="flex flex-col gap-5">
            {/* Progress */}
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <span className="eyebrow text-faint">Progress</span>
                <span className="font-mono text-[12px] font-semibold tabular-nums">{pct}%</span>
              </div>
              {/* No `metric`: this is task PROGRESS, not utilization. With the
                  old unconditional colouring it went amber at 75% and red at
                  90% — reddest right before the job succeeded. */}
              <Meter value={pct} />
            </div>

            {/* Status figures — three columns split by hairlines */}
            <div className="grid grid-cols-3 border-b border-border pb-5">
              <div className="pr-3">
                <div className="whitespace-nowrap font-mono text-[20px] font-bold tabular-nums" data-task-count>
                  {progress.labels?.showCompleted
                    ? (progress.totalNodes > 1 ? `${progress.completedNodes}/${progress.totalNodes}` : "0")
                    : progress.totalNodes}
                </div>
                <div className="eyebrow mt-1 text-faint">{progress.labels?.total || "Total Limit"}</div>
              </div>
              <div className="border-l border-border px-3">
                <div className="font-mono text-[20px] font-bold tabular-nums text-primary">{progress.successNodes}</div>
                <div className="eyebrow mt-1 text-faint">{progress.labels?.success || "Succeeded"}</div>
              </div>
              <div className="border-l border-border px-3">
                <div className="font-mono text-[20px] font-bold tabular-nums text-danger">{progress.failedNodes}</div>
                <div className="eyebrow mt-1 text-faint">{progress.labels?.failed || "Rejected"}</div>
              </div>
            </div>

            {/* Terminal well */}
            <div className="flex flex-col gap-2">
              <span className="eyebrow text-faint">Provider output</span>
              <div
                ref={terminalRef}
                className="flex h-48 flex-col gap-1.5 overflow-y-auto scroll-smooth rounded-lg bg-sunken p-4 font-mono text-[11px] leading-relaxed"
              >
                {progress.logs.map((log, i) => (
                  <div
                    key={i}
                    className={cn(
                      "border-l-2 pl-2",
                      log.includes("SUCCESS")
                        ? "border-primary text-primary"
                        : log.includes("ERROR") || log.includes("FATAL")
                          ? "border-danger text-danger"
                          : "border-faint/40 text-faint"
                    )}
                  >
                    {log}
                  </div>
                ))}
                {isTaskRunning && (
                  <div className="mt-2 flex items-center gap-2 pl-2 text-primary">
                    <Led tone="ok" ping /> Transmitting stream...
                  </div>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              {!isTaskRunning ? (
                <Button variant="solid" onClick={() => setIsModalOpen(false)}>
                  Close
                </Button>
              ) : (
                <Button onClick={() => setIsModalOpen(false)}>
                  Run in background
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </TaskContext.Provider>
  );
}

export function useTask() {
  const context = useContext(TaskContext);
  if (context === undefined) {
    throw new Error("useTask must be used within a TaskProvider");
  }
  return context;
}
