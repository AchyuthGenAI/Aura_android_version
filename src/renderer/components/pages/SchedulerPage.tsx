import { useState } from "react";
import { useAuraStore } from "@renderer/store/useAuraStore";
import type { ScheduledTask } from "@shared/types";
import { Card, Button, SectionHeading, TextInput, TextArea, Switch } from "../shared";

const now = (): number => Date.now();

const formatExecutionMode = (value?: ScheduledTask["executionMode"]): string => {
  if (value === "gateway") return "OpenClaw";
  if (value === "local_browser") return "Aura Local Browser";
  if (value === "local_desktop") return "Aura Local Desktop";
  return "Auto";
};

export const SchedulerPage = (): JSX.Element => {
  const scheduledTasks = useAuraStore((state) => state.scheduledTasks);
  const createScheduledTask = useAuraStore((state) => state.createScheduledTask);
  const deleteScheduledTask = useAuraStore((state) => state.deleteScheduledTask);
  const runScheduledTaskNow = useAuraStore((state) => state.runScheduledTaskNow);

  const [isAdding, setIsAdding] = useState(false);
  const [editingTask, setEditingTask] = useState<Partial<ScheduledTask> | null>(null);

  const handleCreateOrUpdate = async (task: Partial<ScheduledTask>) => {
    if (!task.title || !task.command) return;

    const newTask: ScheduledTask = {
      ...(task as ScheduledTask),
      id: task.id || crypto.randomUUID(),
      title: task.title.trim(),
      command: task.command.trim(),
      type: task.type || "one-time",
      scheduledFor: task.type === "recurring" ? undefined : task.scheduledFor,
      cron: task.type === "recurring" ? task.cron : undefined,
      createdAt: task.createdAt || now(),
      updatedAt: now(),
      status: task.status || "pending",
      enabled: task.enabled ?? true,
      background: task.background ?? true,
      autoApprovePolicy: task.autoApprovePolicy ?? "scheduled_safe",
      executionMode: task.executionMode ?? "gateway",
      preferredSurface: task.preferredSurface,
    };

    await createScheduledTask(newTask);
    setIsAdding(false);
    setEditingTask(null);
  };

  return (
    <div className="mx-auto mt-2 flex h-full w-full max-w-[1280px] flex-col overflow-y-auto pb-8 pr-2">
      <div className="mb-8 flex items-center justify-between">
        <SectionHeading 
          title="Task Scheduler" 
          detail="Schedule complex automation tasks to run perfectly on time." 
        />
        <Button 
          className="bg-aura-gradient text-white shadow-[0_4px_16px_rgba(124,58,237,0.3)] hover:shadow-[0_6px_24px_rgba(124,58,237,0.4)]"
          onClick={() => {
            setEditingTask({ type: "one-time", enabled: true, executionMode: "gateway" });
            setIsAdding(true);
          }}
        >
          + Add New Task
        </Button>
      </div>

      <div className="grid gap-6">
        {scheduledTasks.length === 0 && !isAdding ? (
          <div className="flex flex-col items-center justify-center rounded-[24px] border border-dashed border-white/[0.08] bg-white/[0.01] py-20 text-center transition-all hover:border-white/[0.12] hover:bg-white/[0.03]">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-aura-violet/10 text-aura-violet shadow-[0_0_24px_rgba(124,58,237,0.15)]">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
            <h3 className="text-[16px] font-bold text-aura-text">No scheduled tasks yet</h3>
            <p className="mt-2 max-w-[280px] text-[13px] leading-relaxed text-aura-muted">Create your first task to automate your repetitive workflows.</p>
          </div>
        ) : (
          scheduledTasks.map((task) => (
            <TaskItem 
              key={task.id} 
              task={task} 
              onEdit={() => {
                setEditingTask(task);
                setIsAdding(true);
              }}
              onDelete={() => void deleteScheduledTask(task.id)}
              onRunNow={() => void runScheduledTaskNow(task.id)}
              onToggleEnabled={(enabled) => void createScheduledTask({ ...task, enabled })}
            />
          ))
        )}
      </div>

      {isAdding && (
        <TaskFormModal 
          task={editingTask || {}}
          onClose={() => {
            setIsAdding(false);
            setEditingTask(null);
          }}
          onSave={handleCreateOrUpdate}
        />
      )}
    </div>
  );
};

const TaskItem = ({ 
  task, 
  onEdit, 
  onDelete, 
  onRunNow,
  onToggleEnabled 
}: { 
  task: ScheduledTask; 
  onEdit: () => void; 
  onDelete: () => void; 
  onRunNow: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}) => (
  <div className={`group relative overflow-hidden rounded-[24px] border border-white/[0.05] bg-gradient-to-b from-white/[0.02] to-transparent p-6 transition-all duration-300 hover:-translate-y-0.5 hover:border-aura-violet/20 hover:shadow-[0_8px_30px_rgba(124,58,237,0.08)] ${!task.enabled ? "opacity-60" : ""}`}>
    <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-aura-violet/30 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3">
          <h3 className="text-[17px] font-bold text-aura-text truncate">{task.title}</h3>
          <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
            task.type === "recurring" ? "bg-aura-violet/20 text-aura-violet" : "bg-white/10 text-aura-muted"
          }`}>
            {task.type}
          </span>
          {task.status === "running" && (
            <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-[10px] font-bold uppercase tracking-wider animate-pulse">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Running
            </span>
          )}
        </div>
        <p className="mt-2 text-[14px] text-aura-muted line-clamp-2 italic">"{task.command}"</p>

        <div className="mt-4 flex flex-wrap gap-4 text-[12px] text-aura-muted">
          <div className="flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span>{task.type === "recurring" ? `Cron: ${task.cron}` : `At: ${new Date(task.scheduledFor || 0).toLocaleString()}`}</span>
          </div>
          {task.lastRunAt && (
            <div className="flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              <span>Last run: {new Date(task.lastRunAt).toLocaleString()}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l7 4v6c0 5-3.5 9.74-7 10-3.5-.26-7-5-7-10V6l7-4z"/></svg>
            <span>Engine: {formatExecutionMode(task.executionMode)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 20h8"/></svg>
            <span>Surface: {task.preferredSurface || "Auto"}</span>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 self-center">
        <Switch checked={task.enabled} onChange={onToggleEnabled} />
        <div className="h-8 w-px bg-white/5 mx-1" />
        <button 
          onClick={onRunNow}
          className="p-2 text-aura-muted hover:text-emerald-400 transition-colors"
          title="Run now"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button 
          onClick={onEdit}
          className="p-2 text-aura-muted hover:text-aura-violet transition-colors"
          title="Edit"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button 
          onClick={onDelete}
          className="p-2 text-aura-muted hover:text-rose-400 transition-colors"
          title="Delete"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
      </div>
    </div>
  </div>
);

const TaskFormModal = ({ 
  task, 
  onClose, 
  onSave 
}: { 
  task: Partial<ScheduledTask>; 
  onClose: () => void; 
  onSave: (task: Partial<ScheduledTask>) => void;
}) => {
  const [formData, setFormData] = useState(task);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-xl">
      <div className="w-full max-w-[520px] animate-overlay-enter">
        <div className="rounded-[28px] border border-white/[0.08] bg-gradient-to-b from-[#232136]/98 to-[#0f0e17]/99 p-7 shadow-[0_24px_80px_rgba(124,58,237,0.15)] backdrop-blur-3xl">
          <SectionHeading title={task.id ? "Edit Task" : "New Scheduled Task"} />
          
          <div className="mt-6 space-y-5">
            <label className="block">
              <span className="text-[12px] uppercase tracking-wider text-aura-muted">Title</span>
              <div className="mt-1.5">
                <TextInput 
                  value={formData.title || ""} 
                  onChange={(v) => setFormData({ ...formData, title: v })} 
                  placeholder="Task name (e.g., Morning Update)" 
                />
              </div>
            </label>

            <label className="block">
              <span className="text-[12px] uppercase tracking-wider text-aura-muted">Automation Command</span>
              <div className="mt-1.5">
                <TextArea 
                  value={formData.command || ""} 
                  onChange={(v) => setFormData({ ...formData, command: v })} 
                  placeholder="What should Aura do? (e.g., Go to google.com and search for AI news)" 
                  rows={3}
                />
              </div>
            </label>

            <div className="flex gap-4">
              <label className="flex-1">
                <span className="text-[12px] uppercase tracking-wider text-aura-muted">Type</span>
                <select 
                  value={formData.type}
                  onChange={(e) => setFormData({ ...formData, type: e.target.value as any })}
                  className="mt-1.5 w-full rounded-[20px] border border-white/[0.06] bg-black/20 px-4 py-3 text-[14px] text-aura-text outline-none"
                >
                  <option value="one-time">One-time</option>
                  <option value="recurring">Recurring (CRON)</option>
                </select>
              </label>

              {formData.type === "recurring" ? (
                <label className="flex-1">
                  <span className="text-[12px] uppercase tracking-wider text-aura-muted">CRON Expression</span>
                  <div className="mt-1.5">
                    <TextInput 
                      value={formData.cron || ""} 
                      onChange={(v) => setFormData({ ...formData, cron: v })} 
                      placeholder="e.g. 0 9 * * *" 
                    />
                  </div>
                </label>
              ) : (
                <label className="flex-1">
                  <span className="text-[12px] uppercase tracking-wider text-aura-muted">Time</span>
                  <div className="mt-1.5">
                    <input 
                      type="datetime-local"
                      value={formData.scheduledFor ? new Date(formData.scheduledFor).toISOString().slice(0, 16) : ""}
                      onChange={(e) => setFormData({ ...formData, scheduledFor: new Date(e.target.value).getTime() })}
                      className="w-full rounded-[20px] border border-white/[0.06] bg-black/20 px-4 py-3 text-[14px] text-aura-text outline-none"
                    />
                  </div>
                </label>
              )}
            </div>

            <div className="flex gap-4">
              <label className="flex-1">
                <span className="text-[12px] uppercase tracking-wider text-aura-muted">Execution Surface</span>
                <select
                  value={formData.preferredSurface || ""}
                  onChange={(e) => setFormData({
                    ...formData,
                    preferredSurface: e.target.value ? (e.target.value as ScheduledTask["preferredSurface"]) : undefined,
                  })}
                  className="mt-1.5 w-full rounded-[20px] border border-white/[0.06] bg-black/20 px-4 py-3 text-[14px] text-aura-text outline-none"
                >
                  <option value="">Auto</option>
                  <option value="browser">Browser</option>
                  <option value="desktop">Desktop</option>
                  <option value="mixed">Mixed</option>
                </select>
              </label>

              <label className="flex-1">
                <span className="text-[12px] uppercase tracking-wider text-aura-muted">Automation Engine</span>
                <input
                  value={formatExecutionMode(formData.executionMode ?? "gateway")}
                  readOnly
                  className="mt-1.5 w-full rounded-[20px] border border-white/[0.06] bg-black/20 px-4 py-3 text-[14px] text-aura-text outline-none opacity-80"
                />
              </label>
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-white/5">
              <Button 
                className="bg-white/5 text-aura-text hover:bg-white/10"
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button 
                className="bg-aura-gradient text-white px-8"
                onClick={() => onSave(formData)}
              >
                Save Task
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
