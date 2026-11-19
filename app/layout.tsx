import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { connection } from "next/server";
import "katex/dist/katex.min.css";
import "./globals.css";
// papersplainer: the vendored formula widgets' own styles, then the rules
// that dress them in the app's theme (order matters).
import "@/components/formula/vendor/latex-tangle.css";
import "@/components/formula/vendor/formula-animation.css";
import "@/components/formula/formula.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import RenderEnvSetup from "@/components/render-env-setup";
import { PluginsProvider } from "@/components/plugins";
import { readThemeBoot } from "@/src/server";

// papersplainer (owner, 2026-11-19): chrome, prose and titles = Geist;
// code = Geist Mono. Both ship in the `geist` package as local files (no
// CDN, no build-time fetch). CMU Serif titles (the bundled lh-cmu
// @font-face in globals.css) remain an Appearance option.
const ui = GeistSans;
const mono = GeistMono;

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// The theme is server-rendered — its class AND its color variables —
	// so no first frame ever shows the wrong theme. connection(): the
	// record and the theme files are per-machine disk state — without it a
	// prerendered route (settings) would bake the BUILD machine's record.
	await connection();
	const { appearance, theme, vars } = readThemeBoot();
	return (
		<html
			lang="en"
			className={`${theme.mode} ${ui.variable} ${mono.variable}`}
			style={vars as React.CSSProperties}
			suppressHydrationWarning
		>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<PluginsProvider>
					<AppearanceProvider initialAppearance={appearance} initialTheme={theme}>
						<SidebarProvider>
							<ActivityProvider>
								<AppShell>{children}</AppShell>
							</ActivityProvider>
						</SidebarProvider>
					</AppearanceProvider>
				</PluginsProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
			{/* papersplainer: one-time Manim environment setup, started on first launch. */}
			<RenderEnvSetup />
		</body>
		</html>
	);
}
