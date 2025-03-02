import m, {Children, Component, Vnode} from "mithril"
import type {TranslationKey} from "../../misc/LanguageViewModel"
import {ExpanderButtonN, ExpanderPanelN} from "./Expander"
import {theme} from "../theme"
import type {lazy} from "@tutao/tutanota-utils"
import Stream from "mithril/stream";

export type FolderExpanderAttrs = {
	label: TranslationKey | lazy<string>
	expanded: Stream<boolean>
}

export class FolderExpander implements Component<FolderExpanderAttrs> {
	view(vnode: Vnode<FolderExpanderAttrs>): Children {
		return m(".folder-expander", [
			m(
				".plr-l",
				m(ExpanderButtonN, {
					label: vnode.attrs.label,
					expanded: vnode.attrs.expanded,
					color: theme.navigation_button,
				}),
			),
			m(
				ExpanderPanelN,
				{
					expanded: vnode.attrs.expanded,
				},
				vnode.children,
			),
		])
	}
}