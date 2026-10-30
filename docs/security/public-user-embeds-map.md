# Public user embeds: map (2026-10-29)

Purpose: decide which `storage.ts` functions can switch from "full user row minus passwordHash" to `toPublicProfile()` without breaking a screen.
Allow-list today (`server/utils/publicProfile.ts`): id, username, displayName, avatarUrl, avatar, profilePhotoUrl, bio, userType, organizationName, location, interests, socialMediaLinks, bannerMode, bannerVibe, bannerColor, isVerified, isOfficial, createdAt.

Fields the client reads off embedded users (grep of client/src): username, id, displayName, userType, avatarUrl, organizationName, avatar, isVerified, isOfficial. All are in the allow-list.
Other `user.*` reads (email, dateOfBirth, gender, genderEditedAt, contactEmail, canManageVenues, onboardingComplete, freePromotionCredits, activeSuspension) are the signed-in user's own session (AuthenticatedLayout, EditProfileDialog, MenuTray, Navigation) or admin pages (AdminUsers), not these embeds.

## Group A: convert (public social embeds)
| storage fn | line | consumer |
|---|---|---|
| getPosts | 2271 | social-routes (feed; 2 calls also iterate posts only) |
| searchPosts | 2747 | universalSearch |
| getTrendingPosts | 2836 | users-routes /trending/posts |
| getPostComments | 3104 | social-routes |
| getStoryComments | 3146 | social-routes |
| getCommentThread | 3203 | social-routes |
| getCommentReplies | 3275 | social-routes |
| getActiveStories | 2410 | social-routes (also used inside storage) |
| getStoryViewersWithLikeStatus | 2508 | social-routes |
| getFollowers / getFollowing | 2623 / 2649 | social-routes, users-routes (`f.follower`, `f.following` mapped to user lists) |
| getCommunityMembers | 5713 | community-routes |
| getCommunities / getTrendingCommunities / getCommunityWithDetails (creator) | 5626 / 5829 / 5853 | community-routes |

## Group B: convert only after a closer look (return user rows directly, not embeds)
getSuggestedUsers 2943, getRecommendedUsers 2997, searchUsers 2686 (also feeds universalSearch). Client reads on these lists look limited to the Group A fields, but the follow buttons and cards were not traced one by one.

## Group C: do NOT convert
| fn | why |
|---|---|
| getUserProfile 2664 | the owner's own profile page needs their email/DOB; the route already applies `viewOfUser` per viewer |
| getVenue 4034 | 28 callers across payments, promos, door access; owner data used server-side |
| getSafetyAlerts 3606/3611, getWatchingOver 3833, getFollowingForBuddy 3877, getPendingIncomingBuddyRequests 3899 | buddy/safety UI shows `phoneNumber` to the owner on purpose |

## Not covered by this map
- Chat participants (`p.user.readReceiptsEnabled` in chatUtils): different code path (messages routes), untouched.
- Admin lists: own routes, untouched.

## Open before editing
1. Trace the follow card / suggested-user card components for any field outside the allow-list.
2. Check notifications code for server reads of `.user.email` on these results (none found in the routes grep).
3. Add a leak check: public feed, comments, followers must contain no email/dateOfBirth/phoneNumber.
