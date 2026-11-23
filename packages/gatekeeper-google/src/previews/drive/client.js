// The preview of a file reached through Google Drive (GoogleDriveGatekeeperImpl.getGadgetUi()):
// gadget-format client code that runs in the gadget UI frame, whose page starts it with
// main(gadget, host). There `gadget` is the session of the Drive connection, and the file to draw
// is the one the host sends this to (GadgetHost.onNavigate()): the anchor is the name an edit
// gave its file (ActionDescription.previewOf), then, after a space, a spot in that file as its
// kind of preview names one.
//
// A connection has one set of files, and UI code cannot import() a module once it knows which it
// needs. So the gatekeeper returns this with the previews of all three kinds of file beside it,
// each under its kind's name. This opens the file as a gadget bound to the connection would, by
// the session's own methods, and starts the preview of its kind on the file's session alone. A
// preview builds nothing until it is started, so the other two stand by.

import docs from './docs.js';
import sheets from './sheets.js';
import slides from './slides.js';
import { fitLabel, showError } from './ui/chrome.js';

const PREVIEWS = { docs, sheets, slides };
// The method of a Drive session that opens a file of each kind.
const OPENERS = { docs: 'openGoogleDoc', sheets: 'openGoogleSheet', slides: 'openGoogleSlides' };
// The name an edit gives its file (drivePreviewId() in drive-editors.ts): its kind, the folders
// between the connected one and the file, and the file.
const NAME = /^(docs|sheets|slides):((?:[\w-]+\/)*)([\w-]+)$/;
// What a file of each kind is called where its name is not known: its session does not say it.
const NOUNS = { docs: 'Document', sheets: 'Spreadsheet', slides: 'Presentation' };
// The longest anchor a host takes (MAX_FOCUS_ANCHOR_LENGTH).
const LONGEST_ANCHOR = 256;

async function main(session, host) {
  // The file drawn, by the name it was opened by, and what sends its preview to a spot in it.
  let drawn;
  let goTo;

  // Starts the preview of the file `item` names, as that file's own connection would: on the
  // file's session, with a host that hears of spots in the file and names them from the
  // connection. False when the file or the `spot` in it is not there.
  async function open(item, spot) {
    const [, kind, way = '', fileId] = NAME.exec(item) ?? [];
    // A folder opens only what is directly in it, so the way in is walked, in one round trip:
    // each call is made on the promise of the one before. The file's session stands by itself,
    // so the folders are let go once it is open.
    const folders = [];
    let folder = session;
    for (const id of way.split('/').filter(Boolean)) folders.push(folder = folder.openFolder(id));
    let file;
    try {
      if (!kind) throw new Error('This Google Drive connection has no preview by that name.');
      file = await folder[OPENERS[kind]](fileId);
    } catch (error) {
      showError(error, 'file', () => open(item, spot));
      return false;
    } finally {
      for (const opened of folders) opened[Symbol.dispose]();
    }
    drawn = item;
    // Where the reader is, named from the connection: the file, then the spot in it. A spot too
    // deep to name is left at its file, and a file too deep at the connection.
    const say = focus => {
      const anchor = focus ? `${item} ${focus.anchor}` : item;
      host.reportFocus(focus && anchor.length <= LONGEST_ANCHOR
        ? { ...focus, anchor, label: fitLabel(`${NOUNS[kind]} › ${focus.label}`) }
        : item.length <= LONGEST_ANCHOR ? { anchor: item, label: NOUNS[kind] } : null);
    };
    say(null);
    let found = true;
    await PREVIEWS[kind].main(file, {
      reportFocus: say,
      async onNavigate(navigate) {
        goTo = navigate;
        if (spot !== undefined) found = await navigate(spot) !== false;
      },
    });
    return found;
  }

  // The anchor may come from anywhere, so it only chooses what to draw: the session opens no
  // file that is not one of this connection's.
  let named = false;
  await host.onNavigate(anchor => {
    named = true;
    const space = anchor.indexOf(' ');
    const item = space < 0 ? anchor : anchor.slice(0, space);
    const spot = space < 0 ? undefined : anchor.slice(space + 1);
    if (drawn === undefined) return open(item, spot);
    // A frame draws one file, whose preview is built into its page: the Workshop gives each file
    // a frame of its own.
    if (item !== drawn) return false;
    return spot === undefined || !goTo || goTo(spot);
  });
  if (!named) showError(new Error('No file was named to preview.'), 'file', () => main(session, host));
}

export default { main };
