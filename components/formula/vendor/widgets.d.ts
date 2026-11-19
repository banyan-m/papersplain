/** The anywidget module shape of the vendored front ends. */
export interface WidgetModel {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	save_changes(): void;
	on(event: string, listener: () => void): void;
	off(event: string, listener: () => void): void;
}
export interface WidgetModule {
	render(context: { model: WidgetModel; el: HTMLElement }): Promise<(() => void) | void> | (() => void) | void;
}
