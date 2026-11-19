"use client";

/**
 * The host for the vendored formula widgets (./vendor): the small part of
 * anywidget they need, without marimo or a Python kernel.
 *
 * A widget is `render({ model, el })`. The model is a key-value store with
 * change events: the host sets the configuration, the widget writes back
 * what the learner does (the dragged values) and calls save_changes(), which
 * is where Python would have been told. Here that call reaches `onSave`.
 */

import { useEffect, useRef } from "react";
import type { WidgetModel, WidgetModule } from "./vendor/widgets";

export class HostModel implements WidgetModel {
	private readonly state: Record<string, unknown>;
	private readonly listeners = new Map<string, Set<() => void>>();
	/** Called when the widget commits a change (its save_changes). */
	onSave: (() => void) | undefined;

	constructor(initial: Record<string, unknown>) {
		this.state = { ...initial };
	}
	get(key: string): unknown {
		return this.state[key];
	}
	set(key: string, value: unknown): void {
		this.state[key] = value;
		for (const listener of [...(this.listeners.get(`change:${key}`) ?? [])]) listener();
	}
	save_changes(): void {
		this.onSave?.();
	}
	on(event: string, listener: () => void): void {
		let set = this.listeners.get(event);
		if (!set) this.listeners.set(event, (set = new Set()));
		set.add(listener);
	}
	off(event: string, listener: () => void): void {
		this.listeners.get(event)?.delete(listener);
	}
}

/** "dark" or "light", following the app's theme class on <html>. */
function appTheme(): "dark" | "light" {
	return document.documentElement.classList.contains("light") ? "light" : "dark";
}

/**
 * Mount a widget into a div. `load` imports the module in the browser only
 * (the widgets touch `document` at import time of their render path).
 * `config` is the model's initial state; the widget is remounted when
 * `configKey` changes. The model's theme follows the app's.
 */
export function WidgetHost({
	load,
	config,
	configKey,
	onModel,
	onSave,
	className,
	testid,
}: {
	load: () => Promise<{ default: WidgetModule }>;
	config: Record<string, unknown>;
	configKey: string;
	/** The live model, once created (and null on teardown). */
	onModel?: (model: HostModel | null) => void;
	onSave?: (model: HostModel) => void;
	className?: string;
	testid?: string;
}) {
	const el = useRef<HTMLDivElement>(null);
	const latest = useRef({ config, onModel, onSave });
	latest.current = { config, onModel, onSave };
	useEffect(() => {
		const host = el.current;
		if (!host) return;
		const model = new HostModel({ ...latest.current.config, theme: appTheme() });
		model.onSave = () => latest.current.onSave?.(model);
		latest.current.onModel?.(model);
		let dead = false;
		let dispose: (() => void) | void;
		void load()
			.then((module) => (dead ? undefined : module.default.render({ model, el: host })))
			.then((cleanup) => {
				if (dead) cleanup?.();
				else dispose = cleanup;
			})
			.catch((err: unknown) => {
				if (!dead) host.textContent = `This could not be drawn: ${err instanceof Error ? err.message : String(err)}`;
			});
		const themeWatch = new MutationObserver(() => {
			if (model.get("theme") !== appTheme()) model.set("theme", appTheme());
		});
		themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
		return () => {
			dead = true;
			themeWatch.disconnect();
			dispose?.();
			host.replaceChildren();
			latest.current.onModel?.(null);
		};
	}, [configKey, load]);
	return <div ref={el} className={className} data-testid={testid} />;
}
