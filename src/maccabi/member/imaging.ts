/** Imaging: the member's studies, and what the external MedDream viewer holds for each of them. */
import { ReadRefusal } from "../faults";
import type { MemberScope } from "./context";
import type { Labs, TestRow } from "./labs";
import {
  enterViewer,
  type ImageDetails,
  imageDetails,
  imagePixels,
  imagePreview,
  type PixelData,
  type StudyTree,
  studyTree,
  ViewerRefusal,
  type ViewerSession,
  viewerEntry,
} from "./parse/viewer-study";
import { type Reading, theOnly } from "./shared";

export class Imaging {
  /**
   * Viewer sessions, one for each study, kept for as long as this reader lives. Maccabi mints a
   * handoff token per click, and nothing seen live shows a session serving a study other than the one
   * it was opened for. A different study therefore walks the whole handoff again instead of trying
   * its luck with an earlier session.
   */
  readonly #viewers = new Map<string, ViewerSession>();

  constructor(
    private readonly scope: MemberScope,
    private readonly labs: Labs,
  ) {}

  /**
   * The member's imaging studies: the imaging rows of the one test list. The viewer names a study
   * by its Study Instance UID, and such a row carries that very UID as its `request_id`. The two
   * were compared on a live handoff, character for character, and nothing else in the list so much
   * as looks like a DICOM UID. Without that match no viewer read could be tied to the member.
   */
  async allImagingStudies(): Promise<Reading<TestRow[]>> {
    const listed = await this.labs.allTests();
    const studies = listed.data.tests.filter((line) => line.type === "imaging_study");
    const source = { ...listed.source, operation: "scans", completeness: "local-filtered-subset" } as const;
    return { ...listed, data: studies, source };
  }

  /**
   * The series and instances of one study, as the MedDream viewer lists them once the handoff is
   * done. The viewer names the patient at the top of this answer. Printing it or handing it to a
   * model is safe only after `redact`, which both surfaces run over every result.
   */
  async fetchImagingStudy(studyInstanceUID: string): Promise<Reading<StudyTree>> {
    const label = "scan";
    const viewer = await this.viewerFor(studyInstanceUID, label);
    return this.fromViewer(label, () => studyTree(this.scope.http, viewer));
  }

  /** The DICOM fields of one instance. They include the geometry that `/pixels` relies on and does not repeat. */
  async fetchImagingImage(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string,
  ): Promise<Reading<ImageDetails>> {
    const label = "scan-image";
    const viewer = await this.imageIn(studyInstanceUID, seriesInstanceUID, sopInstanceUID, label);
    return this.fromViewer(label, () => imageDetails(this.scope.http, viewer, seriesInstanceUID, sopInstanceUID));
  }

  /** The preview JPEG the viewer's server renders for one instance. It is neither DICOM nor of diagnostic quality. */
  async fetchImagingImageThumbnail(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string,
  ): Promise<Reading<Uint8Array>> {
    const label = "scan-preview";
    const viewer = await this.imageIn(studyInstanceUID, seriesInstanceUID, sopInstanceUID, label);
    return this.fromViewer(label, () => imagePreview(this.scope.http, viewer, seriesInstanceUID, sopInstanceUID));
  }

  /**
   * The raw pixels of one instance together with the numbers needed to read them. The bytes cannot
   * be asked for alone, and that is on purpose. The viewer sends them without a header, so by
   * themselves they are a block nobody can interpret or even check for truncation. The DICOM
   * fields are read first, and their arithmetic has to match the byte count before anything is returned.
   */
  async fetchImagingImagePixels(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string,
  ): Promise<Reading<PixelData>> {
    const label = "scan-pixels";
    const viewer = await this.imageIn(studyInstanceUID, seriesInstanceUID, sopInstanceUID, label);
    return this.fromViewer(label, async () => {
      const meta = await imageDetails(this.scope.http, viewer, seriesInstanceUID, sopInstanceUID);
      return imagePixels(this.scope.http, viewer, seriesInstanceUID, sopInstanceUID, meta);
    });
  }

  /**
   * The viewer session for one study, opened only once the study is known to be the member's: the
   * UID must pick exactly one row out of the imaging studies listed for this call. A single field
   * is all there is to compare, because the viewer's address takes nothing but the UID; the
   * document downloads can do better and match request_id and doc_id as a pair. That comparison is
   * also the whole defence. Nothing seen live says whether MedDream would turn away a study the
   * handoff never named, so nothing here counts on it.
   */
  private async viewerFor(studyInstanceUID: string, label: string): Promise<ViewerSession> {
    if (typeof studyInstanceUID !== "string" || studyInstanceUID === "")
      throw new TypeError("a study is named by its Study Instance UID");
    const studies = (await this.allImagingStudies()).data;
    theOnly(
      studies.filter((line) => line.request_id === studyInstanceUID),
      label,
    );
    const open = this.#viewers.get(studyInstanceUID);
    if (open) return open;
    const checksum = this.scope.memberChecksum;
    if (!checksum) throw new ReadRefusal("NO_PORTAL_TOKEN", label);
    const viewer = await this.guarded(label, () => {
      const entry = viewerEntry(this.scope.owner, checksum, studyInstanceUID);
      return enterViewer(this.scope.http, entry, studyInstanceUID);
    });
    this.#viewers.set(studyInstanceUID, viewer);
    return viewer;
  }

  /**
   * The study's viewer, once the series and instance asked for are found, exactly once, in what the
   * viewer itself lists for that study right now. A UID from anywhere else never gets into an address.
   */
  private async imageIn(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string,
    label: string,
  ): Promise<ViewerSession> {
    const viewer = await this.viewerFor(studyInstanceUID, label);
    const { series } = await this.guarded(label, () => studyTree(this.scope.http, viewer));
    const instances = series.flatMap((one) => (one.seriesInstanceUID === seriesInstanceUID ? one.instances : []));
    theOnly(
      instances.filter((instance) => instance.sopInstanceUID === sopInstanceUID),
      label,
    );
    return viewer;
  }

  private async fromViewer<T>(label: string, read: () => Promise<T>): Promise<Reading<T>> {
    return this.scope.result(await this.guarded(label, read), "MedDream", label);
  }

  /** Runs viewer work and raises its refusals again as this operation's: code and status kept, the label added. */
  private async guarded<T>(label: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (caught) {
      if (caught instanceof ViewerRefusal) throw new ReadRefusal(caught.code, label, caught.status);
      throw caught;
    }
  }
}
