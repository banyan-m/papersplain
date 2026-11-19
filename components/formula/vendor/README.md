# Vendored formula widgets

`latex-tangle.js/.css` and `formula-animation.js/.css` are the front ends of
`TangleLatex` and `FormulaAnimation` from
[koaning/wigglystuff](https://github.com/koaning/wigglystuff) (MIT, `LICENSE`
here), version 0.6.0, commit `576c56ea92195b5b17b2ba50f48162cb525eaa59`.

They are anywidget modules: `export default { render({ model, el }) }`, using
only `model.get / set / save_changes / on / off`. papersplainer runs them
without marimo or Python: `../widget-host.tsx` supplies the model, and
`src/core/formula.ts` ports the validation the Python classes did.

## Local changes

Each file has one, marked `papersplainer:` — KaTeX and its stylesheet come
from the app's bundled copy instead of jsDelivr (offline, no remote code).
Nothing else is edited, and the CSS files are byte-for-byte upstream.

## Updating

Copy the four files from a newer wigglystuff, reapply the loader change
(the header comment, the `import bundledKatex`, and the replaced loader
functions), update the version and commit above, and run
`tests/papersplainer-formula*.test.*`. If upstream changes which model
fields it reads, update `src/core/formula.ts` to match.
