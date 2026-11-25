import { Masthead } from "@/components/layout/masthead";
import { TickerRibbon } from "@/components/layout/ticker-ribbon";
import { RouteBreadcrumbs } from "@/components/layout/route-breadcrumbs";
import { RouteFade } from "@/components/layout/route-fade";
import { BottomTabBar } from "@/components/layout/bottom-tab-bar";
import { TaskProvider } from "@/components/providers/task-provider";
import { SettingsProvider } from "@/components/providers/settings-provider";
import { SyncRunProvider } from "@/components/providers/sync-run-provider";
import { fleetConfig } from "@/fleet.config";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SettingsProvider>
    <TaskProvider>
    <SyncRunProvider>
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
        <Masthead />
        <TickerRibbon />

        {/* Scrollable plane — pages reference this id. The scrollbar's space
            is held whether or not the page is long enough to scroll, so a
            short page and a long one put their content in the same place.
            The masthead and ticker pad their right side by the same width
            (--sbw, measured in app/layout.tsx). */}
        <div
          id="main-scroll-container"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-[calc(72px+env(safe-area-inset-bottom))] [scrollbar-gutter:stable] md:pb-0"
        >
          <main className="mx-auto w-full max-w-[1360px] flex-1 px-5 py-6 lg:px-8">
            <RouteBreadcrumbs />
            <RouteFade>{children}</RouteFade>
          </main>

          <footer className="border-t border-line-strong">
            <div className="mx-auto w-full max-w-[1360px] px-5 py-4 lg:px-8">
              <p className="eyebrow text-faint">
                {`${fleetConfig.footerLabel} · Data: Supabase · GridPane API · Refresh\u00a0600s`}
              </p>
            </div>
          </footer>
        </div>

        <BottomTabBar />
      </div>
    </SyncRunProvider>
    </TaskProvider>
    </SettingsProvider>
  );
}
