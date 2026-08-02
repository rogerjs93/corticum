# stroke_qeeg — motor imagery dataset for stroke

**Licence: CC BY 4.0** (Creative Commons Attribution 4.0 International).

Source: *"motor imagery dataset for stroke"*, 50 stroke patients recorded at the
Department of Neurology, Xuanwu Hospital, Capital Medical University, Beijing.
<https://doi.org/10.6084/m9.figshare.21393402>

CC BY 4.0 permits redistribution and adaptation, including commercially,
provided attribution is given and changes are indicated. Both are done here.

## What corticum redistributes, and how it is modified

**No raw recordings are redistributed.** The source EDF files total ~505 MB and
none of them ship. Two derived artifacts do:

`public/fields/qeeg.json` (~129 kB), from `tools/prep/eeg_bandpower.py`:

1. The 29 EEG channels are picked (HEOL/HEOR are EOG and dropped), re-referenced
   to the average, band-pass filtered 1–45 Hz and notch filtered at 50 Hz.
2. Split into 4 s epochs; epochs exceeding 150 µV peak-to-peak are rejected.
3. Welch PSD averaged over surviving epochs, integrated into five bands, and
   divided by total 1–45 Hz power to give **relative** band power.
4. A delta/alpha ratio per channel, and the fraction of epochs retained.

The result is 29 channels × 6 numbers per patient. It is a summary statistic,
not a recording, and the original time series cannot be recovered from it.

`public/fields/presets.json` (~27 kB), from `tools/prep/eeg_presets.py`:

5. The `participants.tsv` columns are carried through unchanged (age, gender,
   NIHSS, MBI, mRS, paralysis side, duration, and the free-text
   `StrokeLocation`).
6. Each `StrokeLocation` string is parsed into occlusion sites and sides by a
   keyword map. **That mapping is an interpretation added by corticum**, not
   part of the source dataset, and every approximate entry is flagged as such in
   the file and in the UI.

## Caveats that travel with the data

- These are **motor imagery** recordings, not resting state. Clinical qEEG
  markers such as the delta/alpha ratio are validated on resting-state EEG, so
  published thresholds do not transfer.
- Measured on this cohort, **the delta/alpha ratio does not lateralise to the
  lesion** (54% across 46 unilateral patients — chance). This is recorded in
  `qeeg.json` under `measuredNegativeResult` and stated in the UI. The cortical
  overlay shows scalp topography mapped onto anatomy; it is not a lesion
  localiser.
- Participants are pseudonymised in the source dataset (`sub-01` … `sub-50`) and
  corticum adds nothing that could re-identify them.
