// The preview of a file reached through Google Drive (GoogleDriveGatekeeperImpl.getGadgetUi()):
// gadget-format client code that runs in the gadget UI frame, whose page starts it with
// main(gadget). There `gadget` is the session of one file, which the Drive session's
// openPreview() opened: a Doc's, a spreadsheet's or a presentation's.
//
// A connection has one set of files, and UI code cannot import() a module once it knows which it
// needs. So the gatekeeper returns this with the previews of all three kinds of file beside it,
// each under its kind's name, and this starts the one whose kind the session says it is. A
// preview builds nothing until it is started, so the other two stand by.

import docs from './docs.js';
import sheets from './sheets.js';
import slides from './slides.js';
import { showError } from './ui/chrome.js';

const PREVIEWS = { docs, sheets, slides };

async function main(session) {
  let kind;
  try {
    kind = await session.getPreviewKind();
  } catch (error) {
    return showError(error, 'file', () => main(session));
  }
  PREVIEWS[kind].main(session);
}

export default { main };
