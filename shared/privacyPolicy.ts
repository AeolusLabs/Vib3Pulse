// Privacy policy content, kept apart from the page so counsel can edit wording without touching code.
// Every statement here is checked against .superpowers/sdd/data-inventory.md (what the code actually does). Do not add a promise the code does not keep.

export interface PolicySection {
  id: string; title: string; paragraphs: string[]; bullets?: string[];
  /** Extra text that is shown only while age review is switched on. The whole section is hidden when `ageReviewOnly`. */
  whenAgeReview?: { paragraphs?: string[]; bullets?: string[] };
  ageReviewOnly?: boolean;
  /** Paragraphs shown after the bullet list. */
  afterBullets?: string[];
}
export interface PrivacyPolicy {
  version: "2026-10-v4";
  status: "draft" | "final";
  lastUpdated: "2026-10-26";
  contactEmail: "info@aeoluslabsltd.com";
  sections: PolicySection[];
}

/** Shown only to people who chose to receive money. The pop-up uses the same words (client/src/lib/ageReview.ts). */
export const PAYOUTS_NAME_NOTE = "Because you chose to receive money, we also keep the full name on your document, encrypted. It is used only to check that your bank account is in your name. We delete it if you delete your account or an administrator removes your verification.";

export const DRAFT_BADGE = "Draft, under legal review";
/** The badge text while the policy is a draft; null once it is final. */
export const policyBadge = (status: PrivacyPolicy["status"]): string | null => (status === "draft" ? DRAFT_BADGE : null);

/** The sections to show. With age review off, its section and every sentence about it are left out, so the text still reads correctly. */
export function visibleSections(policy: PrivacyPolicy, ageReviewEnabled: boolean): PolicySection[] {
  return policy.sections
    .filter((s) => ageReviewEnabled || !s.ageReviewOnly)
    .map((s) => {
      const extra = ageReviewEnabled ? s.whenAgeReview : undefined;
      return {
        id: s.id, title: s.title,
        paragraphs: [...s.paragraphs, ...(extra?.paragraphs ?? [])],
        ...(s.bullets || extra?.bullets ? { bullets: [...(s.bullets ?? []), ...(extra?.bullets ?? [])] } : {}),
        ...(s.afterBullets ? { afterBullets: s.afterBullets } : {}),
      };
    });
}

export const PRIVACY_POLICY: PrivacyPolicy = {
  version: "2026-10-v4",
  status: "draft",
  lastUpdated: "2026-10-26",
  contactEmail: "info@aeoluslabsltd.com",
  sections: [
    {
      id: "summary",
      title: "In short",
      paragraphs: [
        "Vib3Pulse is a social app for events, venues and live rooms. To run it we handle some personal information. This page explains what, why, who can see it and what you can do about it.",
        "This policy is a draft that is still being reviewed. The facts in it describe how the app works today.",
      ],
      whenAgeReview: { bullets: ["You can use most of Vib3Pulse without proving your age. Proving you are an adult is only needed for tipping, buying tickets and hosting paid rooms."] },
      bullets: [
        "Card numbers do not reach our servers. Payments are taken by our payment providers.",
        "Your map location is shared only if you turn it on.",
        "You can delete your account in Account settings. Some things stay behind, and we say which below.",
      ],
    },
    {
      id: "who-we-are",
      title: "Who we are",
      paragraphs: [
        "Vib3Pulse runs this app and decides how your information is used. For anything in this policy, write to info@aeoluslabsltd.com.",
      ],
    },
    {
      id: "what-we-collect",
      title: "What we collect",
      paragraphs: ["It depends on what you use. Here is the list, by feature."],
      bullets: [
        "Account: your email address, username, display name, password (stored only as a one way scrambled value), and your birthdate. If you sign in with Google, we receive your Google profile id, email, name and photo.",
        "Profile: the things you choose to add, such as bio, interests, city, gender, links, phone number, photos and avatar. Organizer and venue accounts can add an organization name and a contact email.",
        "Phone number checks: if you verify a phone number, we send a one time code by text message and keep the verified number.",
        "Content: posts, comments, likes, stories, polls, photos and videos you upload. Uploaded media is stored in our database and is opened through a link that is not guessable but is not behind a login.",
        "Messages: direct messages and group chats, including images and shared items. Event group chats are removed 7 days after the event.",
        "Location sharing: off by default. If you turn it on, we store one current position, rounded to about 100 metres, and treat it as gone after 30 minutes without an update. We keep no history of it. You choose who can see it.",
        "Safety Buddy and alerts: the names and phone numbers of the buddies you add, and if you send an alert, the location and message in it. An alert can include a share link that works without logging in and expires after 7 days.",
        "Tickets and payments: what you bought, amounts, payment references and check in records. Your card number is entered with the payment provider and does not reach our servers. If you save a card for tipping, we keep a provider token (encrypted) and the last four digits, brand and bank name. Hosts who get paid give bank details to the payment provider; we keep the bank name and the last four digits of the account.",
        "Rooms: who joined and when, your role, and how many chat lines you sent. Room chat lines are held in memory only while the room is open and are dropped when it ends. We do not record room audio or video. If someone reports a room, some of the most recent chat lines can be attached to the report.",
        "Notifications: your in app notifications, and your browser push address if you turn push on.",
        "Location for a city name: when you ask the app to use your location to fill in a city, your browser can send your coordinates to OpenStreetMap's Nominatim service to turn them into a city name. We store the city text.",
        "Device and network data: your IP address and a device cookie, used for login security and to enforce bans. Our servers also log requests and sign in events, including IP addresses.",
        "Cookies: a session cookie that keeps you signed in (30 days), a security token cookie (24 hours), a device cookie (up to 2 years), and a small display preference for the side menu. We do not use advertising or analytics cookies, and the app has no analytics or advertising trackers.",
      ],
      whenAgeReview: { bullets: ["Age review: if you ask us to verify your age, see the section on age verification below.", `Name on your document (only if you choose to receive money): ${PAYOUTS_NAME_NOTE}`] },
    },
    {
      id: "why-we-use-it",
      title: "Why we use it",
      paragraphs: ["We use your information to:"],
      bullets: [
        "run your account, sign you in and keep it secure;",
        "show your profile and content to the people you choose;",
        "deliver messages, notifications, tickets, rooms and map features;",
        "take payments, pay hosts and keep money records;",
        "keep members safe, including enforcing age groups, handling reports and banning abusive accounts.",
      ],
      whenAgeReview: { bullets: ["Check that people who tip, buy tickets or host paid rooms are adults."] },
    },
    {
      id: "who-sees-it",
      title: "Who can see it",
      paragraphs: [
        "Other members see what your settings allow. Posts and profiles may be public. Map location is visible only to the audience you pick (people you follow who follow you back, or a list you choose), and not to people you have blocked.",
        "Anyone who has the link to a photo or video you uploaded can open it, because those links do not require a login. Do not upload anything you would not want a link holder to see.",
        "Vib3Pulse staff can see account and safety information they need to do their job. Admin actions are logged with a reason.",
      ],
      whenAgeReview: { paragraphs: ["ID photos are seen only by Vib3Pulse staff who review ages (administrators, super administrators and age reviewers), as described in the age verification section."] },
    },
    {
      id: "who-we-share-with",
      title: "Who we share it with",
      paragraphs: ["We use other companies to run parts of the service. They receive only what that part needs."],
      bullets: [
        "Railway hosts the app and our database.",
        "Paystack and Stripe take payments. They receive your email, the amount and a reference. Hosts who are paid also give bank details to the provider.",
        "LiveKit carries live audio and video in rooms. It receives your user id, display name and your audio and video streams while you are in a call.",
        "Resend sends our emails, such as sign up confirmation, password reset and receipts.",
        "Twilio and Termii send text messages for phone codes, Safety Buddy invites and alerts. They receive the phone number and the message, which can include a location and share link.",
        "Zernio posts to social accounts that event organizers connect.",
        "Sentry may receive error reports from our servers if we have switched error monitoring on.",
        "Google handles Google sign in. Google Fonts supplies fonts, and map tiles come from OpenFreeMap and OpenStreetMap, which see your IP address and the area you view.",
        "Browser push services (such as those run by Google, Mozilla and Apple) carry push notifications.",
        "OpenStreetMap's Nominatim service turns coordinates into a city name when you use your location, and also looks up addresses of events and venues.",
        "Players for YouTube, Vimeo, Spotify, SoundCloud and Apple Music can load in rooms, and they see your IP address when they do.",
      ],
    },
    {
      id: "children",
      title: "Children and age groups",
      paragraphs: [
        "You must be at least 13 to use Vib3Pulse. Your age comes from the birthdate you give. We do not have a parental consent step.",
        "Members aged 13 to 17 are treated as a teen group, with these protections:",
      ],
      bullets: [
        "Direct messages between an adult and someone under 18 are blocked unless both people turn on a setting for it (it is off by default), and a warning is shown.",
        "Rooms hosted by someone under 18 are minors' rooms. An adult can join only with a personal invite from the host that they acknowledge.",
        "Rooms can have age limits, and 18+ and 21+ rooms are for adults.",
        "Tipping, paid tickets and hosting paid rooms need an adult whose age has been verified.",
      ],
    },
    {
      id: "age-review",
      title: "Age verification",
      ageReviewOnly: true,
      paragraphs: [
        "If you choose to verify your age, you can upload a photo of an identity document and a selfie holding a one time code, or take a private live video check with a reviewer. This is optional. Saying no only means the adult only features stay off.",
        "Who sees it: Only Vib3Pulse staff who review ages (administrators, super administrators and age reviewers). Your images are encrypted in our database and are opened one at a time, with every viewing logged. For a live check, a reviewer sees you on a private call. Nothing is recorded or saved.",
        "How long: for an upload, we delete your photos after the final decision, or after 7 days from when you started, whichever comes first. If a second approval is needed, they are kept until that is decided, within the 7 days. If you cancel before a decision, your photos are deleted.",
        "What we keep: We keep a record of the decision: who made it, when, the type of document, whether the birthdate matched, and the reason if it was declined. A reviewer may also write a short note about the decision (up to 300 characters), which is kept in our staff audit log. We also keep the birthdate you registered with at the time, and a one-way code made from your document number. The code cannot be turned back into the number without our secret key, and it only stops the same document being used on several accounts. We do not keep your photos or the document number itself. Notifications and emails about the result do not contain your documents.",
        `Receiving money: ${PAYOUTS_NAME_NOTE}`,
        "Your birthdate: a reviewer compares the document with the birthdate you gave when you signed up. If it shows you are under 18, we move your account to the right age group. If it shows a different adult birthdate, a second senior reviewer must approve before we change it.",
        "Your choices: Cover everything except your photo, name and date of birth. Cancel any time before a decision and your photos are deleted. Choose the live check instead of uploading. Saying no only means the adult only features stay off.",
        "Your safety: If your document shows you are under 18, we will move your account to the right age group.",
        "Consent: before anything is captured, a notice explains this and you must tick a box to continue. You can withdraw by cancelling the request before a decision.",
      ],
    },
    {
      id: "your-choices-and-rights",
      title: "Your choices and rights",
      paragraphs: ["In the app you can:"],
      bullets: [
        "edit your profile, change your username and password, and change or remove your photo;",
        "control read receipts, whether friends see your event attendance, and who can interact with you in rooms;",
        "turn map sharing on or off and choose who sees it;",
        "turn push notifications on or off and delete notifications;",
        "remove a saved card and disconnect connected social accounts;",
        "delete your account in Account settings.",
      ],
    },
    {
      id: "deleting-your-account",
      title: "Deleting your account",
      paragraphs: [
        "Deleting your account removes your profile details, birthdate, phone number, location, linked devices and some event data, and ends your session. Your email and username are replaced.",
        "It does not remove everything. These stay, and your posts and messages show as from a Deleted user:",
      ],
      bullets: [
        "posts, comments and stories;",
        "direct messages and group messages;",
        "uploaded photos and videos;",
        "who you followed or blocked;",
        "notifications and browser push subscriptions;",
        "Safety Buddy contacts (including buddy phone numbers), alerts (including location coordinates) and message delivery records;",
        "reports made about you or by you;",
        "the record of a saved card (you can remove a saved card yourself in the app);",
        "connected social accounts;",
        "money records, which are kept by design because they are needed for accounts and disputes.",
      ],
      afterBullets: [
        "You can ask us to remove more by emailing info@aeoluslabsltd.com.",
        "There is no tool for exporting your data yet. For anything else, such as a copy of your information, a correction, or removal of something not covered above, email info@aeoluslabsltd.com. Ask us as well about how long server logs and backups are kept.",
      ],
    },
    {
      id: "retention",
      title: "How long some things are kept",
      paragraphs: ["Where the app removes data on a schedule, this is what it does:"],
      bullets: [
        "Map position: treated as gone after 30 minutes without an update, and removed when you stop sharing.",
        "Event group chats: removed 7 days after the event.",
        "Guest details for private social events: removed 30 days after the event, with a longer hold if a case is open.",
        "Safety Buddy invites expire after 48 hours.",
        "Failed login records are cleared after 30 minutes.",
      ],
      whenAgeReview: { bullets: ["ID photos: as described in the age verification section."] },
    },
    {
      id: "security",
      title: "Security",
      paragraphs: [
        "Passwords are stored hashed. Saved card tokens are encrypted. Sessions use secure cookies and sign in attempts are rate limited. Staff access is limited by role and logged.",
        "Messages and most profile details are stored on our servers without extra encryption for you alone. No system is perfectly secure, and we cannot promise it is.",
      ],
      whenAgeReview: { paragraphs: ["ID photos, while we hold them, are encrypted."] },
    },
    {
      id: "changes",
      title: "Changes to this policy",
      paragraphs: [
        "When we change this policy we update the version and the date at the top of this page.",
      ],
      whenAgeReview: { paragraphs: ["If the age verification notice changes, you will be asked to accept the new one when you start a request."] },
    },
    {
      id: "contact",
      title: "Contact",
      paragraphs: ["Questions, requests about your data, or concerns: info@aeoluslabsltd.com."],
    },
  ],
};
