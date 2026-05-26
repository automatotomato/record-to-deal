import { AppShell } from "@/components/AppShell";
import { ProjectGuide as ProjectGuideComponent } from "@/components/ProjectGuide";

const ProjectGuide = () => {
  return (
    <AppShell>
      <div className="px-8 py-6 border-b border-border bg-card flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">About this project</div>
          <h1 className="font-display text-5xl leading-none">Project Guide.</h1>
        </div>
      </div>
      <ProjectGuideComponent />
    </AppShell>
  );
};

export default ProjectGuide;
