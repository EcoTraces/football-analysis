// Spec sections 2, 24, 44: every surface that shows probabilities must carry
// this messaging, and it must never be watered down to make room for hype.
export function ResponsibleGamblingFooter() {
  return (
    <footer className="mt-12 border-t border-slate-200 px-4 py-6 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
      <p className="mx-auto max-w-4xl">
        Football predictions on this site are probabilistic estimates based on available data. No
        prediction is guaranteed, and past model performance does not guarantee future results. This is a
        statistical research tool, not betting advice — nothing here is a "sure bet," "guaranteed win," or
        "fixed match." If you choose to bet, only stake what you can afford to lose, and treat every figure
        as an estimate, not a certainty.
      </p>
    </footer>
  );
}
