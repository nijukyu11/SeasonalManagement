# Kế hoạch triển khai Realtime Gantt và cuộn khi kéo

> **Dành cho agent triển khai:** Thực hiện tuần tự từng task, giữ nguyên phạm vi của từng commit, viết kiểm thử RED trước khi sửa mã và không triển khai production nếu chưa có phê duyệt riêng.

**Goal:** Khi một máy thay đổi quầy thủ tục hoặc gate, máy còn lại cập nhật trực tiếp đúng thanh trên Gantt mà không reload màn hình. Nếu nhiều thao tác ghi cùng một đối tượng, trạng thái có `serverSeq` lớn nhất thắng. Trong lúc kéo cụm quầy hoặc gate, người dùng vẫn cuộn dọc bằng con lăn/touchpad và Gantt tự cuộn liên tục khi con trỏ ở sát mép.

**Architecture:** Dùng hai đường xử lý realtime. Đường nhanh xác thực sự kiện mutation đầy đủ rồi vá trực tiếp entity vào Zustand và các window snapshot đang chứa entity đó. Đường chậm chỉ đánh dấu stale và chạy một lần revalidate nền đã coalesce khi có gap, reconnect, payload không đủ tin cậy hoặc thay đổi membership. Một bộ phân xử theo từng `seasonId + targetType + targetId` hoãn sự kiện của đúng đối tượng đang drag/resize/commit; sự kiện của đối tượng khác vẫn áp dụng ngay. Check-in và Gate dùng chung bộ điều khiển Pointer Events để xử lý wheel/touchpad và edge auto-scroll bằng `requestAnimationFrame`.

**Tech stack:** Next.js, React, TypeScript, Zustand, Supabase Realtime/RPC, Pointer Events, Node test runner, Tauri v2.

---

## Phạm vi và điều kiện bất biến

- Supabase/RPC tiếp tục là nguồn dữ liệu có thẩm quyền. Không thêm SQLite, sidecar hoặc cache trình duyệt làm nguồn thắng xung đột.
- Kế hoạch này bổ sung fast path realtime và drag-scroll cho `2026-07-13-server-first-route-reload-hardening.md`; không gỡ `AppRouteCache`, snapshot-first SWR hoặc shared server-window coordinator đã có.
- “Thao tác cuối cùng” được xác định bằng `serverSeq` do server cấp, không dùng đồng hồ máy khách, thời điểm nhận websocket hoặc thứ tự promise hoàn tất trên trình duyệt.
- Sự kiện realtime hợp lệ cho `modification` chỉ được vá trực tiếp khi có `serverSeq` hữu hạn và payload chứa bản `FlightModification` canonical đầy đủ của đúng `legId`. Payload thiếu, không biết loại, delete/add, thay đổi record membership hoặc nghi ngờ gap phải đi đường revalidate nền.
- Sự kiện thường không được gọi `router.refresh()`, `location.reload()`, remount route, bật loading blocker hoặc thay toàn bộ workspace snapshot.
- Direct patch không tăng generation để tự kích hoạt fetch và không đặt `staleReason`. Nó chỉ cập nhật entity, snapshot có liên quan, high-water tương ứng và metadata high-water.
- Revalidate nền phải single-flight/coalesced theo season/window. Có snapshot thì giữ nguyên UI hiện tại trong lúc fetch; chỉ thay dữ liệu khi response còn đúng operator epoch và generation.
- Khi đang tương tác với đối tượng A, realtime của A được xếp hàng; realtime của B áp dụng ngay. Khi local mutation của A được server xác nhận hoặc thất bại, so sánh tất cả candidate theo `serverSeq`, chỉ áp dụng candidate lớn nhất.
- Local optimistic result và remote event phải đi qua cùng hàng rào high-water. Response cũ không được ghi đè event mới chỉ vì promise hoàn tất sau.
- Chỉ bỏ qua websocket echo từ chính client sau khi mutation response đã cung cấp và áp dụng cùng `serverSeq`; không được bỏ qua mà không nâng high-water.
- Direct patch phải giữ nguyên vị trí scroll, zoom, selection, filter, panel state, pool state và draft không liên quan.
- Không gọi RPC, ghi store toàn workspace hoặc rebuild toàn bộ allocation trong `pointermove`, `wheel` hay mỗi frame auto-scroll.
- Bộ auto-scroll chỉ chạy khi đang drag và vận tốc khác 0; dừng sạch ở `pointerup`, `pointercancel`, `Escape`, unmount, đổi season và mất quyền thao tác.
- Wheel listener chỉ `preventDefault()` khi drag đang active và sự kiện thuộc vùng Gantt; ngoài trạng thái đó phải giữ hành vi cuộn bình thường của trang.
- Giữ nguyên thay đổi có sẵn trong `AGENTS.md`; kế hoạch này không chỉnh file đó.
- Mỗi task kết thúc bằng kiểm thử GREEN và một commit riêng. Tổng cộng: **12 task / 12 commit**.

## Hiện trạng cần sửa

- `app/src/app/components/SeasonSyncProvider.tsx` đang bỏ `opPayload`, chỉ đánh dấu toàn workspace stale rồi phát sự kiện rút gọn. Vì vậy route không có dữ liệu canonical để vá một thanh Gantt.
- `app/src/lib/seasonWorkspaceStore.ts` có `recordServerHighWater` và `modificationServerHighWater`, nhưng `patchSeasonWorkspace()` chưa dùng chúng để chặn response/event cũ và đang đánh dấu mọi window là stale sau patch.
- Callback của `useSeasonWorkspaceRefresh()` trên các route chủ yếu đọc lại snapshot cache; việc reload thủ công mới buộc server-window revalidate nên máy khác chưa thấy thay đổi ngay.
- Check-in dùng chặn refresh toàn cục trong lúc drag/resize/commit. Cách này hoãn cả thay đổi của đối tượng khác.
- Gate chưa có hàng rào cùng đối tượng khi pointer drag đang active.
- Check-in vẫn dựa vào native HTML5 `draggable`; edge scroll chỉ chạy theo `dragover`, không có wheel handler và không tiếp tục cuộn nếu con trỏ đứng yên ở mép.
- Gate đã dùng pointer capture nhưng `pointermove` chỉ cập nhật preview/overlay, chưa điều khiển scroll container.

## Luồng dữ liệu đích

1. RPC ghi mutation atomically và trả `appliedEvents`/`serverHighWater`; bản ghi event Supabase có `serverSeq` tăng đơn điệu.
2. `SeasonSyncProvider` giữ nguyên sự kiện đầy đủ, kiểm tra tính liên tục của sequence và phân loại direct patch hoặc fallback revalidate.
3. Với direct patch, bộ phân xử tương tác quyết định áp dụng ngay hay xếp hàng theo target.
4. Store chỉ nhận patch nếu chưa có target high-water hoặc `serverSeq > targetHighWater`; sequence bằng nhau được xem là duplicate. Store patch entity và mọi snapshot đang chứa entity đó mà không làm stale window.
5. Check-in/Gate đang mount nhận đúng entity mới qua selector/subscription và cập nhật thanh tương ứng, không thay loading state hoặc scroll state.
6. Gap, reconnect, payload không đầy đủ hoặc membership change được coalesce thành một server-window revalidate nền.

---

## Task 1: Khóa contract realtime và xung đột bằng kiểm thử RED

**Files:**

- Create: `app/src/lib/seasonRealtimePatch.test.ts`
- Modify: `app/src/app/components/SeasonSyncProvider.source.test.ts`
- Modify: `app/src/app/syncFetchBoundary.source.test.ts`
- Modify: `app/src/app/serverWindowSWRRoutes.source.test.ts`

- [ ] **Step 1: Viết ma trận contract trước khi sửa mã**

Thêm test mô tả tối thiểu các trường hợp:

- `serverSeq=102` thắng `serverSeq=101` dù event `101` đến sau.
- Hai event khác target được áp dụng độc lập.
- Payload `modification` đầy đủ được phân loại direct patch.
- Payload thiếu `mod`, `serverSeq=null`, delete/add hoặc target không biết được phân loại fallback.
- Cùng một `eventId`/`opId` không được áp dụng hai lần.
- Direct event không được đánh dấu toàn workspace stale và không phát chuỗi refresh màn hình.
- Source test của sáu route không được coi việc gọi `loadSeasonWorkspaceWindow()` ở vị trí bất kỳ là đủ; phải chứng minh callback fallback thực sự revalidate qua coordinator, còn direct event không gọi callback đó.

- [ ] **Step 2: Chạy RED**

Chạy từ `app`:

```powershell
node --experimental-strip-types --test src/lib/seasonRealtimePatch.test.ts
node --experimental-strip-types --test src/app/components/SeasonSyncProvider.source.test.ts src/app/syncFetchBoundary.source.test.ts src/app/serverWindowSWRRoutes.source.test.ts
```

Expected: FAIL vì classifier/direct-patch contract chưa tồn tại và source hiện còn bỏ payload.

- [ ] **Step 3: Commit**

```powershell
git add app/src/lib/seasonRealtimePatch.test.ts app/src/app/components/SeasonSyncProvider.source.test.ts app/src/app/syncFetchBoundary.source.test.ts app/src/app/serverWindowSWRRoutes.source.test.ts
git commit -m "test(realtime): lock direct gantt update contract"
```

---

## Task 2: Xác minh server sequence là nguồn quyết định cuối cùng

**Files:**

- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/src/lib/supabaseStore.source.test.ts`
- Modify: `docs/handoffs/online-first-server-authoritative-writes.md`

- [ ] **Step 1: Kiểm tra migration/RPC có thẩm quyền**

Đối chiếu RPC mutation đang deploy với migration nguồn ở repository backend `opsdata-supabase`. Phải có bằng chứng rằng trong cùng transaction, server khóa season, áp mutation, chèn event, cấp `serverSeq` tăng đơn điệu và trả event/sequence cho client. Nếu không lấy được migration/deployment evidence thì dừng task ở trạng thái blocked, không tự suy luận từ TypeScript client.

- [ ] **Step 2: Viết test contract response**

Khóa các yêu cầu:

- `appliedEvents` giữ nguyên `eventId`, `opId`, `targetType`, `targetId`, `opPayload` và `serverSeq`.
- `serverHighWater`/`nextServerSeq` không bị mất khi normalize.
- Một request có `baseServerSeq` cũ nhưng mutation hợp lệ vẫn được server tuần tự hóa; client không tự từ chối bằng last-write-wins dựa trên local clock.
- Response thiếu sequence không được đi direct path.

- [ ] **Step 3: Sửa adapter tối thiểu và chạy GREEN**

Chỉ sửa kiểu/normalizer nếu test chứng minh client đang làm mất contract. Không thay đổi semantics backend bằng workaround ở UI.

```powershell
node --experimental-strip-types --test src/lib/supabaseStore.source.test.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 4: Ghi bằng chứng vào handoff và commit**

Nêu migration/function/version đã xác minh, môi trường kiểm tra và giới hạn chưa xác minh. Không ghi “production đã đúng” nếu chưa có live evidence.

```powershell
git add app/src/lib/remoteStore.ts app/src/lib/supabaseStore.ts app/src/lib/supabaseStore.source.test.ts docs/handoffs/online-first-server-authoritative-writes.md
git commit -m "fix(sync): preserve authoritative mutation sequence"
```

---

## Task 3: Tạo classifier và cursor guard cho sự kiện realtime

**Files:**

- Create: `app/src/lib/seasonRealtimePatch.ts`
- Modify: `app/src/lib/seasonRealtimePatch.test.ts`
- Modify: `app/src/lib/seasonChangeEvents.ts`

**Interfaces dự kiến:**

```ts
export type SeasonRealtimeDecision =
  | { kind: 'ignore-duplicate-or-stale'; serverSeq: number }
  | { kind: 'direct-modification'; serverSeq: number; legId: string; modification: FlightModification }
  | { kind: 'revalidate-window'; reason: 'gap' | 'missing-sequence' | 'incomplete-payload' | 'membership-change' | 'unknown-target' };

export function classifySeasonRealtimeEvent(
  event: SeasonChangeEvent,
  cursor: SeasonRealtimeCursor,
): SeasonRealtimeDecision;
```

- [ ] **Step 1: Bổ sung test cho cursor/gap**

Khóa duplicate, out-of-order, sequence liên tiếp, gap `101 -> 104`, reconnect chưa có cursor và event của season khác. Cursor phải theo season, không dùng một biến toàn app.

- [ ] **Step 2: Implement classifier thuần**

Classifier không đọc DOM/store và không fetch. Chỉ direct khi event canonical đủ dữ liệu. Gap không được làm mất event mới: ghi nhận high-water quan sát được rồi yêu cầu revalidate để dựng lại state chính xác.

- [ ] **Step 3: Chạy GREEN**

```powershell
node --experimental-strip-types --test src/lib/seasonRealtimePatch.test.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 4: Commit**

```powershell
git add app/src/lib/seasonRealtimePatch.ts app/src/lib/seasonRealtimePatch.test.ts app/src/lib/seasonChangeEvents.ts
git commit -m "feat(realtime): classify ordered season events"
```

---

## Task 4: Thêm server-event patch có high-water vào workspace store

**Files:**

- Modify: `app/src/lib/seasonWorkspaceStore.ts`
- Modify: `app/src/lib/seasonWorkspaceStore.test.ts`

**Interface dự kiến:**

```ts
applyServerModificationPatch(input: {
  seasonId: string;
  legId: string;
  modification: FlightModification;
  serverSeq: number;
  operatorSessionEpoch: number;
}): 'applied' | 'ignored-stale' | 'missing-target' | 'invalid-epoch';
```

- [ ] **Step 1: Viết test store RED**

Bao phủ:

- Patch `102`, sau đó patch `101`: state vẫn là bản `102`.
- Patch cập nhật `modificationsByLegId` và mọi `windowSnapshots` đang chứa `legId`.
- Window không chứa target không bị thay object reference không cần thiết.
- Direct patch không tăng `generation`, không đổi `requestStatus`, không đặt `staleReason`.
- `modificationServerHighWater[legId]` và `windowMetadata.serverHighWater` tăng đơn điệu.
- Operator epoch cũ bị từ chối.
- Local mutation ack cũ không thể ghi đè remote event mới.

- [ ] **Step 2: Implement action riêng**

Không tái sử dụng nguyên trạng `patchSeasonWorkspace()` vì action đó đang có semantics mutation/stale rộng hơn. Dùng copy-on-write đúng map/snapshot liên quan để selector của route nhận thay đổi mà không remount.

- [ ] **Step 3: Chạy GREEN**

```powershell
node --experimental-strip-types --test src/lib/seasonWorkspaceStore.test.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 4: Commit**

```powershell
git add app/src/lib/seasonWorkspaceStore.ts app/src/lib/seasonWorkspaceStore.test.ts
git commit -m "feat(store): apply ordered server modification patches"
```

---

## Task 5: Tạo bộ phân xử theo đúng đối tượng đang thao tác

**Files:**

- Create: `app/src/lib/ganttInteractionArbiter.ts`
- Create: `app/src/lib/ganttInteractionArbiter.test.ts`

**Interfaces dự kiến:**

```ts
export interface GanttTargetKey {
  seasonId: string;
  targetType: 'modification';
  targetId: string;
}

export interface GanttInteractionArbiter {
  begin(key: GanttTargetKey): void;
  enqueueOrApply(key: GanttTargetKey, candidate: SequencedModificationPatch): 'queued' | 'applied';
  settle(key: GanttTargetKey, localAck?: SequencedModificationPatch): SequencedModificationPatch | null;
  cancel(key: GanttTargetKey): SequencedModificationPatch | null;
  disposeSeason(seasonId: string): void;
}
```

- [ ] **Step 1: Viết test ma trận cạnh tranh**

- A đang drag, remote A `102`: queue.
- A đang drag, remote B `103`: B apply ngay.
- Local A ack `101`, queued A `102`: remote thắng.
- Queued A `102`, local A ack `103`: local thắng.
- Local thất bại: candidate remote lớn nhất được áp dụng.
- Nhiều event queued/out-of-order: chỉ candidate có sequence lớn nhất còn lại.
- `pointercancel`, đổi season và unmount không để interaction lock bị treo.

- [ ] **Step 2: Implement arbiter thuần**

Không giữ React component hoặc DOM node trong registry. So sánh sequence ở một nơi duy nhất và để callback apply đi qua store action Task 4.

- [ ] **Step 3: Chạy GREEN**

```powershell
node --experimental-strip-types --test src/lib/ganttInteractionArbiter.test.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 4: Commit**

```powershell
git add app/src/lib/ganttInteractionArbiter.ts app/src/lib/ganttInteractionArbiter.test.ts
git commit -m "feat(gantt): arbitrate concurrent target updates"
```

---

## Task 6: Nối full realtime event vào provider và fallback revalidate có kiểm soát

**Files:**

- Modify: `app/src/app/components/SeasonSyncProvider.tsx`
- Modify: `app/src/app/components/SeasonSyncProvider.source.test.ts`
- Modify: `app/src/lib/seasonDataCache.ts`
- Modify: `app/src/app/hooks/useSeasonWorkspaceRefresh.ts`
- Modify: `app/src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts`
- Modify: `app/src/lib/seasonWorkspaceWindowCoordinator.ts`
- Modify: `app/src/lib/seasonWorkspaceWindowCoordinator.test.ts`

- [ ] **Step 1: Giữ nguyên full event ở ranh giới subscription**

Không rút event xuống chỉ còn `affectedIds`. Provider phân loại event, áp direct patch hoặc phát fallback event có `reason`. Subscription status reconnect phải tạo một lần reconcile; sequence gap cũng phải cùng đi qua cơ chế này.

- [ ] **Step 2: Xử lý own-client event đúng sequence**

Mutation response được xử lý trước qua cùng store high-water. Websocket echo chỉ được bỏ qua nếu `opId/eventId` đã được ack và high-water target đã bằng hoặc cao hơn sequence đó. Giới hạn bộ nhớ dedupe theo season và dọn khi unsubscribe.

- [ ] **Step 3: Coalesce fallback, không tạo reload loop**

`useSeasonWorkspaceRefresh()` chỉ gọi coordinator cho `revalidate-window`; direct patch không schedule timer refresh. Trong một burst gap/reconnect, mỗi window có tối đa một request đang chạy và một request trailing nếu generation thay đổi.

- [ ] **Step 4: Chạy GREEN**

```powershell
node --experimental-strip-types --test src/app/components/SeasonSyncProvider.source.test.ts src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts src/lib/seasonWorkspaceWindowCoordinator.test.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 5: Commit**

```powershell
git add app/src/app/components/SeasonSyncProvider.tsx app/src/app/components/SeasonSyncProvider.source.test.ts app/src/lib/seasonDataCache.ts app/src/app/hooks/useSeasonWorkspaceRefresh.ts app/src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts app/src/lib/seasonWorkspaceWindowCoordinator.ts app/src/lib/seasonWorkspaceWindowCoordinator.test.ts
git commit -m "feat(realtime): patch directly with coalesced reconciliation"
```

---

## Task 7: Tích hợp cập nhật trực tiếp và last-write-wins vào Check-in

**Files:**

- Modify: `app/src/app/checkin/page.tsx`
- Modify: `app/src/app/checkin/checkInLocalCommitWorker.ts`
- Modify: `app/src/app/checkin/workspaceRefreshScope.ts`
- Modify: `app/src/app/checkin/workspaceRefreshScope.test.ts`
- Create: `app/src/app/checkin/realtimeCheckInPatch.source.test.ts`

- [ ] **Step 1: Thay defer toàn route bằng defer theo target**

Khi drag/resize/commit một `legId`, đăng ký đúng target với arbiter. Không dùng trạng thái `syncing || dragging || resizing` để chặn thay đổi của mọi quầy.

- [ ] **Step 2: Cho thanh Check-in nhận modification mới trực tiếp**

Selector/subscription chỉ cập nhật allocation của affected `legId`; giữ scroll, zoom, selected flight, filter, expanded group và pool. Không gọi full `refreshCheckInWindow()` cho direct patch.

- [ ] **Step 3: Đưa optimistic write và mutation ack qua high-water**

`checkInLocalCommitWorker` trả event/sequence canonical cho page. Khi ack, gọi `arbiter.settle()` và store action Task 4; không dùng `patchSeasonWorkspace()` không có sequence để overwrite mù.

- [ ] **Step 4: Viết test cạnh tranh tại route**

Kiểm tra cùng target/different target, local success/failure, event đến trước/sau ack và direct update không đổi loading/scroll state.

- [ ] **Step 5: Chạy GREEN**

```powershell
node --experimental-strip-types --test src/app/checkin/workspaceRefreshScope.test.ts src/app/checkin/realtimeCheckInPatch.source.test.ts src/app/checkin/checkInCommitErrors.test.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 6: Commit**

```powershell
git add app/src/app/checkin/page.tsx app/src/app/checkin/checkInLocalCommitWorker.ts app/src/app/checkin/workspaceRefreshScope.ts app/src/app/checkin/workspaceRefreshScope.test.ts app/src/app/checkin/realtimeCheckInPatch.source.test.ts
git commit -m "feat(checkin): apply live counter updates in place"
```

---

## Task 8: Tích hợp cập nhật trực tiếp và last-write-wins vào Gate

**Files:**

- Modify: `app/src/app/gate/page.tsx`
- Modify: `app/src/app/gate/gateLocalCommitWorker.ts`
- Create: `app/src/app/gate/realtimeGatePatch.source.test.ts`

- [ ] **Step 1: Đăng ký vòng đời pointer drag theo target**

Gọi `begin()` khi drag gate bắt đầu; gọi `settle()` sau mutation ack; gọi `cancel()` khi pointer cancel/Escape hoặc local mutation lỗi. Remote event của gate khác vẫn render ngay.

- [ ] **Step 2: Áp direct patch không reset Gantt**

Chỉ cập nhật thanh/nhóm có `legId` liên quan. Giữ thời gian đang xem, scroll, lựa chọn, pool và overlay. Direct event không gọi refresh toàn window.

- [ ] **Step 3: Chặn late local response**

`gateLocalCommitWorker` phải trả sequence canonical. Response seq thấp hơn target high-water bị bỏ qua; queued remote cao hơn phải thắng sau settle.

- [ ] **Step 4: Chạy test**

```powershell
node --experimental-strip-types --test src/app/gate/realtimeGatePatch.source.test.ts src/lib/ganttInteractionArbiter.test.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 5: Commit**

```powershell
git add app/src/app/gate/page.tsx app/src/app/gate/gateLocalCommitWorker.ts app/src/app/gate/realtimeGatePatch.source.test.ts
git commit -m "feat(gate): apply live gate updates in place"
```

---

## Task 9: Hoàn thiện fallback revalidation cho sáu route mà không nhấp nháy

**Files:**

- Modify: `app/src/app/seasonal/page.tsx`
- Modify: `app/src/app/detailed/page.tsx`
- Modify: `app/src/app/daily/page.tsx`
- Modify: `app/src/app/checkin/page.tsx`
- Modify: `app/src/app/gate/page.tsx`
- Modify: `app/src/app/dashboard/page.tsx`
- Modify: `app/src/app/serverWindowSWRRoutes.source.test.ts`
- Modify: `app/src/app/syncFetchBoundary.source.test.ts`

- [ ] **Step 1: Phân biệt direct và fallback ở mọi route**

Direct modification được store/route selector xử lý, không gọi fetch callback. Chỉ fallback event mới gọi `loadSeasonWorkspaceWindow()` qua shared coordinator với `forceRevalidate` có generation/cursor guard.

- [ ] **Step 2: Giữ snapshot khi revalidate**

Nếu đã có snapshot, route giữ UI ready và chỉ biểu thị background refresh nhẹ nếu cần; không xóa records/modifications, không reset scroll, không đóng modal/draft.

- [ ] **Step 3: Khóa không lặp fetch**

Source/behavior test phải chứng minh một burst realtime direct bằng 0 fetch, còn gap/reconnect burst chỉ tạo một request active và tối đa một trailing reconcile.

- [ ] **Step 4: Chạy GREEN**

```powershell
node --experimental-strip-types --test src/app/serverWindowSWRRoutes.source.test.ts src/app/syncFetchBoundary.source.test.ts src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 5: Commit**

```powershell
git add app/src/app/seasonal/page.tsx app/src/app/detailed/page.tsx app/src/app/daily/page.tsx app/src/app/checkin/page.tsx app/src/app/gate/page.tsx app/src/app/dashboard/page.tsx app/src/app/serverWindowSWRRoutes.source.test.ts app/src/app/syncFetchBoundary.source.test.ts
git commit -m "fix(routes): reconcile realtime gaps without remounting"
```

---

## Task 10: Xây bộ điều khiển cuộn khi kéo dùng chung

**Files:**

- Create: `app/src/lib/ganttDragScroll.ts`
- Create: `app/src/lib/ganttDragScroll.test.ts`
- Create: `app/src/app/hooks/useGanttDragScroll.ts`
- Create: `app/src/app/hooks/useGanttDragScroll.source.test.ts`
- Modify: `app/src/lib/checkinAllocation.ts`

**Contract hành vi:**

- Wheel/touchpad `deltaY` cuộn dọc ngay khi đang giữ drag; `deltaX` và hành vi ngang hiện có không bị mất.
- Khi pointer nằm trong vùng mép trên/dưới, vận tốc tăng dần theo khoảng cách vào vùng mép và tiếp tục chạy bằng `requestAnimationFrame` dù pointer đứng yên.
- Mỗi frame clamp `scrollTop` vào `[0, scrollHeight - clientHeight]`, sau đó tính lại drop preview theo bounding rect mới.
- Không auto-scroll khi đã chạm biên, pointer ra ngoài vùng cho phép hoặc drag kết thúc.

- [ ] **Step 1: Viết test math và lifecycle RED**

Test threshold, max velocity, clamp, high-resolution touchpad delta, wheel ở ngoài Gantt, rAF start/stop, pointer cancel, Escape và unmount cleanup.

- [ ] **Step 2: Tách math khỏi React hook**

Tái sử dụng hoặc thay `calculateCheckInEdgeScroll()` bằng hàm generic. Hook nhận `scrollRef`, active pointer, callback recompute preview và axis policy; chỉ hook mới gắn listener/rAF.

- [ ] **Step 3: Bảo vệ hiệu năng**

Không set React state nếu drop target/scroll offset không đổi. Batch preview tối đa một lần mỗi animation frame; không rebuild toàn bộ allocation từ hook.

- [ ] **Step 4: Chạy GREEN**

```powershell
node --experimental-strip-types --test src/lib/ganttDragScroll.test.ts src/app/hooks/useGanttDragScroll.source.test.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 5: Commit**

```powershell
git add app/src/lib/ganttDragScroll.ts app/src/lib/ganttDragScroll.test.ts app/src/app/hooks/useGanttDragScroll.ts app/src/app/hooks/useGanttDragScroll.source.test.ts app/src/lib/checkinAllocation.ts
git commit -m "feat(gantt): add shared drag scroll controller"
```

---

## Task 11: Áp dụng wheel và edge auto-scroll cho Check-in và Gate

**Files:**

- Modify: `app/src/app/checkin/page.tsx`
- Modify: `app/src/app/gate/page.tsx`
- Create: `app/src/app/checkin/dragScroll.source.test.ts`
- Create: `app/src/app/gate/dragScroll.source.test.ts`

- [ ] **Step 1: Chuyển drag Check-in khỏi native HTML5 DnD**

Dùng Pointer Events/pointer capture thống nhất với controller Task 10 để wheel hoạt động ổn định trong lúc giữ drag. Bảo toàn offset của cả cụm, drop vào resource/pool, resize handle, click/context menu và ảnh/overlay phản hồi. Ngưỡng movement phải ngăn click nhẹ bị hiểu thành drag.

- [ ] **Step 2: Nối Check-in scroll container**

Wheel/touchpad cuộn trực tiếp trong lúc drag; edge trên/dưới chạy liên tục. Sau mỗi scroll, recompute row/drop time theo rect mới để preview và kết quả drop không lệch.

- [ ] **Step 3: Nối Gate vào cùng controller**

Giữ pointer capture hiện có nhưng bỏ logic scroll trùng lặp. Bảo toàn quy tắc khóa trục của nhóm gate đã phân bổ, drop vào pool và overlay; chỉ thêm cuộn dọc/wheel cùng recompute preview.

- [ ] **Step 4: Kiểm tra cleanup và accessibility**

`pointerup`, `pointercancel`, `Escape`, blur/unmount đều dừng rAF, release capture và xóa overlay. Focus/keyboard hiện có không bị mất; `touch-action` chỉ giới hạn trên handle cần drag.

- [ ] **Step 5: Chạy GREEN**

```powershell
node --experimental-strip-types --test src/app/checkin/dragScroll.source.test.ts src/app/gate/dragScroll.source.test.ts src/lib/ganttDragScroll.test.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 6: Commit**

```powershell
git add app/src/app/checkin/page.tsx app/src/app/gate/page.tsx app/src/app/checkin/dragScroll.source.test.ts app/src/app/gate/dragScroll.source.test.ts
git commit -m "fix(gantt): keep scrolling while dragging allocations"
```

---

## Task 12: Kiểm thử hai máy, kiểm thử Tauri và cập nhật tài liệu

**Files:**

- Modify: `context.md`
- Modify: `architecture.md`
- Modify: `docs/handoffs/online-first-server-authoritative-writes.md`
- Modify: `docs/superpowers/plans/2026-08-16-realtime-gantt-direct-patch-and-drag-scroll.md`

- [x] **Step 1: Chạy toàn bộ automated gate**

Từ `app`:

```powershell
node --experimental-strip-types --test src/lib/seasonRealtimePatch.test.ts src/lib/seasonWorkspaceStore.test.ts src/lib/ganttInteractionArbiter.test.ts src/lib/ganttDragScroll.test.ts
node --experimental-strip-types --test src/app/components/SeasonSyncProvider.source.test.ts src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts src/app/serverWindowSWRRoutes.source.test.ts src/app/syncFetchBoundary.source.test.ts
node --experimental-strip-types --test src/app/checkin/realtimeCheckInPatch.source.test.ts src/app/checkin/dragScroll.source.test.ts src/app/gate/realtimeGatePatch.source.test.ts src/app/gate/dragScroll.source.test.ts
npx tsc --noEmit --pretty false
npm run test:rules
npm run build
```

- [ ] **Step 2: Kiểm thử realtime bằng hai phiên độc lập** — Blocked trong workspace hiện tại vì chưa có phiên operator/backend cô lập và chưa được phép chạy mutation production.

Dùng hai browser context hoặc hai máy đăng nhập vào cùng season test, ghi lại network log và video/screenshot nếu phù hợp:

| Tình huống | Kết quả bắt buộc |
|---|---|
| Máy A đổi Check-in, máy B đứng yên | Chỉ thanh liên quan trên B đổi; không reload, không loading blocker |
| Máy A đổi Gate, máy B đứng yên | Chỉ thanh liên quan trên B đổi; scroll/selection giữ nguyên |
| A đang kéo target X, B đổi target Y | Y cập nhật ngay trên A |
| A đang kéo X, B đổi X | Event X được queue; sau local ack bản có `serverSeq` lớn nhất hiển thị |
| A và B commit X gần như đồng thời | Cả hai hội tụ về cùng bản có sequence cao nhất |
| Websocket ngắt rồi nối lại | Một lần background reconcile; không lặp reload/fetch |
| Payload cố ý thiếu hoặc sequence gap | Không direct patch mù; fallback dựng lại state chính xác |

Không chạy mutation trên production nếu chưa có season/record test cô lập, kế hoạch cleanup và phê duyệt riêng.

- [ ] **Step 3: Kiểm thử cuộn trên desktop/Tauri** — Blocked vì chưa có packaged Tauri/device acceptance với chuột và touchpad vật lý.

Trên Check-in và Gate, kiểm tra chuột có wheel và touchpad:

- Giữ kéo cụm ở giữa Gantt rồi cuộn lên/xuống.
- Giữ pointer ở mép trên/dưới ít nhất 3 giây; Gantt phải tiếp tục cuộn khi pointer đứng yên.
- Vừa edge-scroll vừa vượt nhiều row rồi thả; target/drop time phải đúng preview.
- Chạm đầu/cuối scroll, kéo ra ngoài, nhấn Escape và chuyển route; không còn rAF/listener treo.
- Thử drag/resize/context menu/click bình thường để phát hiện regression.

- [x] **Step 4: Cập nhật tài liệu bằng bằng chứng thật**

Ghi rõ fast path, fallback path, server-sequence LWW, per-target interaction queue và drag-scroll lifecycle. Chỉ đánh dấu checklist plan hoàn tất khi có log test tương ứng; ghi riêng phần blocked nếu chưa có thiết bị/tài khoản/môi trường.

- [x] **Step 5: Chạy QA tài liệu UTF-8**

Từ repository root:

```powershell
$plan = 'docs/superpowers/plans/2026-08-16-realtime-gantt-direct-patch-and-drag-scroll.md'
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $plan))
$strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
$null = $strictUtf8.GetString($bytes)
$mojibake = @(
  [string][char]0x00C3,
  [string][char]0x00C2,
  ([string][char]0x00E1 + [char]0x00BA),
  [string][char]0x00C6,
  [string][char]0x00C4,
  [string][char]0xFFFD
) -join '|'
$markers = @('TO' + 'DO', 'T' + 'BD', 'PLACE' + 'HOLDER') -join '|'
rg -n "$mojibake|$markers" $plan context.md architecture.md docs/handoffs/online-first-server-authoritative-writes.md
$text = [System.IO.File]::ReadAllText((Resolve-Path $plan), [System.Text.Encoding]::UTF8)
$taskCount = [regex]::Matches($text, '(?m)^## Task \d+:').Count
$commitCount = [regex]::Matches($text, '(?m)^git commit -m ').Count
$fenceCount = [regex]::Matches($text, '(?m)^```').Count
if ($taskCount -ne 12 -or $commitCount -ne 12 -or ($fenceCount % 2) -ne 0) {
  throw "Plan structure failed: tasks=$taskCount commits=$commitCount fences=$fenceCount"
}
```

Expected: strict UTF-8 decode PASS và `rg` không trả kết quả do nội dung mới gây ra.

Kết quả thực thi 2026-08-16:

- Core realtime/store/arbiter/drag-scroll: 16/16 PASS.
- Provider/refresh/route-boundary: 26/26 PASS.
- Check-in/Gate realtime và drag-scroll: 12/12 PASS.
- `npx tsc --noEmit --pretty false`: PASS.
- `npm run test:rules`: PASS sau khi regression harness được cập nhật cho shared drag-scroll và Pointer Events.
- `npm run build`: PASS với Next.js 16.2.4; 10 route ứng dụng được prerender thành công.
- Xác minh live function, hai phiên operator và Tauri/device: BLOCKED như Step 2-3; không có production mutation nào được chạy.

- [x] **Step 6: Commit**

```powershell
git add context.md architecture.md docs/handoffs/online-first-server-authoritative-writes.md docs/superpowers/plans/2026-08-16-realtime-gantt-direct-patch-and-drag-scroll.md
git commit -m "docs(gantt): record realtime and drag-scroll verification"
```

---

## Thứ tự phụ thuộc

```text
Task 1 -> Task 2 -> Task 3 -> Task 4 -> Task 5 -> Task 6
                                      |           |
                                      v           v
                                    Task 7      Task 8
                                      \           /
                                       -> Task 9

Task 10 -> Task 11

Task 9 + Task 11 -> Task 12
```

Không bắt đầu Task 7/8 trước khi store high-water và arbiter đã GREEN. Task 10 có thể làm song song về mặt kỹ thuật với Task 2-9, nhưng lịch sử commit vẫn phải giữ đúng thứ tự trong kế hoạch để dễ review/bisect.

## Done means

- Thay đổi quầy thủ tục/gate từ máy khác xuất hiện trực tiếp trên thanh Gantt liên quan mà không reload route hay bật loading blocker.
- Hai máy cùng sửa một đối tượng hội tụ về bản có `serverSeq` lớn nhất, kể cả event và local ack đến trình duyệt sai thứ tự.
- Đang thao tác một đối tượng không chặn realtime của đối tượng khác và không làm thanh đang kéo bị giật bởi remote event cùng target.
- Gap/reconnect/payload không an toàn tự đối soát nền đúng một cách coalesced, không tạo vòng lặp fetch/reload.
- Check-in và Gate đều cuộn được bằng wheel/touchpad trong lúc giữ drag và tự cuộn liên tục ở mép trên/dưới.
- Tất cả test/typecheck/rules/build nêu trên PASS; kiểm thử hai phiên và Tauri có evidence hoặc được báo rõ là blocked, không được suy diễn là đã đạt.
- Không có mojibake, placeholder, listener/rAF bị rò rỉ, thay đổi ngoài phạm vi hoặc chỉnh sửa `AGENTS.md`.
