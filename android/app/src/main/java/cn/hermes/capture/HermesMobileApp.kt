package cn.hermes.capture

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

private val paper = Color(0xFFFCFAF5)
private val ink = Color(0xFF06261F)
private val muted = Color(0xFF697671)
private val forest = Color(0xFF2C6852)
private val border = Color(0xFFDEE2DA)
private val serif = FontFamily(Font(R.font.noto_serif_sc_regular), Font(R.font.noto_serif_sc_bold, FontWeight.Bold))
private enum class Screen { HOME, TOPIC, PARSING, SETTINGS, PROVIDERS, SERVICE, GROUP, DETAIL }
private fun typeLabel(type: String): String = when (type.lowercase()) {
    "skill" -> "Skill"; "prompt" -> "Prompt"; "tool" -> "工具"; "inspiration", "idea" -> "灵感"
    "knowledge" -> "知识"; "method" -> "方法"; "resource" -> "资源"; else -> type.ifBlank { "卡片" }
}

@Composable
fun HermesMobileApp(context: Context, captureStore: CaptureStore, serviceEnabled: () -> Boolean,
                    openAccessibility: () -> Unit, exportDiagnostics: () -> Unit) {
    val scope = rememberCoroutineScope()
    val api = remember { MobileApi(context.applicationContext) }
    val mobileConfigStore = remember { MobileConfigStore(context.applicationContext) }
    val receiverStore = remember { ReceiverConfigStore(context.applicationContext) }
    var screen by remember { mutableStateOf(Screen.HOME) }
    var catalog by remember { mutableStateOf(Catalog.from(api.cachedLibrary())) }
    var jobs by remember { mutableStateOf(jobsFrom(api.cachedJobs())) }
    var providerView by remember { mutableStateOf(api.cachedProviders() ?: JSONObject()) }
    var selectedTopic by remember { mutableStateOf("") }
    var selectedSource by remember { mutableStateOf("") }
    var selectedFromSearch by remember { mutableStateOf(false) }
    var selectedCard by remember { mutableStateOf<CardItem?>(null) }
    var notice by remember { mutableStateOf("") }
    var refreshing by remember { mutableStateOf(false) }
    var manualRefreshResult by remember { mutableStateOf("") }
    var prefetchedRevision by remember { mutableStateOf("") }
    var deleteJob by remember { mutableStateOf<JobItem?>(null) }
    val config = mobileConfigStore.read()

    suspend fun refresh(manual: Boolean = false) {
        if (!mobileConfigStore.read().isComplete) {
            if (manual) manualRefreshResult = "请先在设置中保存手机卡片库连接。"
            return
        }
        refreshing = true
        if (manual) manualRefreshResult = "正在从云端读取…"
        try {
            val updated = withContext(Dispatchers.IO) { api.library() }
            val freshCatalog = Catalog.from(updated)
            catalog = freshCatalog
            val revision = updated.optString("revision")
            if (prefetchedRevision != revision) {
                prefetchedRevision = revision
                scope.launch(Dispatchers.IO) { api.prefetchImages(freshCatalog) }
            }
            jobs = jobsFrom(withContext(Dispatchers.IO) { api.jobs() })
            providerView = withContext(Dispatchers.IO) { api.providers() }
            notice = ""
            if (manual) manualRefreshResult = "刷新成功：${freshCatalog.topics.size} 个主题、${freshCatalog.cards.size} 张卡片。"
            else if (manualRefreshResult.contains("失败") || manualRefreshResult.contains("密钥")) manualRefreshResult = ""
        } catch (error: Exception) {
            notice = if (error.message?.contains("HTTP 401") == true) {
                "手机卡片库密钥验证失败（401）。请在设置 → 服务与后端重新填写手机专用密钥；收藏上传密钥不能用于这里。"
            } else {
                "云端暂不可用，当前显示本机缓存。${error.message.orEmpty()}"
            }
            if (manual) manualRefreshResult = "刷新失败：$notice"
        } finally { refreshing = false }
    }

    suspend fun command(action: String, eventId: String? = null, payload: JSONObject? = null) {
        try {
            val id = withContext(Dispatchers.IO) {
                if (action.startsWith("provider_")) api.providerCommand(action, payload ?: JSONObject())
                else api.command(action, eventId)
            }
            notice = "已送达操作，等待 Mac 确认…"
            repeat(20) {
                delay(1_000)
                val result = withContext(Dispatchers.IO) { api.commandStatus(id) }
                if (result.optString("status") in listOf("completed", "failed")) {
                    notice = result.optString("result").ifBlank { if (result.optString("status") == "completed") "操作完成" else "操作失败" }
                    refresh()
                    return
                }
            }
            notice = "Mac 当前未响应；操作已排队，稍后会继续。"
        } catch (error: Exception) { notice = error.message ?: "操作失败" }
    }

    LaunchedEffect(Unit) {
        while (true) {
            refresh()
            delay(15_000)
        }
    }

    fun back() {
        screen = when (screen) {
            Screen.TOPIC -> Screen.HOME
            Screen.GROUP -> if (selectedFromSearch) Screen.HOME else Screen.TOPIC
            Screen.DETAIL -> if (catalog.cards.count { it.sourceId == selectedSource } > 1) Screen.GROUP else if (selectedFromSearch) Screen.HOME else Screen.TOPIC
            Screen.PROVIDERS, Screen.SERVICE -> Screen.SETTINGS
            else -> Screen.HOME
        }
    }
    BackHandler(screen !in listOf(Screen.HOME, Screen.PARSING, Screen.SETTINGS)) { back() }

    MaterialTheme {
        Column(Modifier.fillMaxSize().background(paper).statusBarsPadding()) {
            if (notice.isNotBlank()) Text(notice, Modifier.fillMaxWidth().background(Color(0xFFE9F1E9)).padding(horizontal = 18.dp, vertical = 9.dp), color = forest, fontSize = 12.sp)
            Box(Modifier.weight(1f)) {
                when (screen) {
                    Screen.HOME -> HomeScreen(catalog, refreshing, manualRefreshResult, onTopic = { selectedTopic = it; screen = Screen.TOPIC },
                        onSearchSource = { source ->
                            selectedSource = source
                            selectedFromSearch = true
                            val cards = catalog.cards.filter { it.sourceId == source }
                            if (cards.size == 1) { selectedCard = cards.first(); screen = Screen.DETAIL } else screen = Screen.GROUP
                        }, onRefresh = { scope.launch { refresh(true) } })
                    Screen.TOPIC -> TopicScreen(catalog, selectedTopic, ::back) { source ->
                        selectedSource = source
                        selectedFromSearch = false
                        val cards = catalog.cards.filter { it.sourceId == source }
                        if (cards.size == 1) { selectedCard = cards.first(); screen = Screen.DETAIL }
                        else screen = Screen.GROUP
                    }
                    Screen.GROUP -> GroupScreen(catalog.cards.filter { it.sourceId == selectedSource }, ::back) { selectedCard = it; screen = Screen.DETAIL }
                    Screen.DETAIL -> selectedCard?.let { DetailScreen(it, api, context, ::back) }
                    Screen.PARSING -> ParsingScreen(jobs, catalog, refreshing, onRefresh = { scope.launch { refresh(true) } },
                        onRetry = { scope.launch { command("retry", it) } }, onDelete = { deleteJob = it })
                    Screen.SETTINGS -> SettingsScreen(config.isComplete, serviceEnabled(), onProviders = { screen = Screen.PROVIDERS }, onService = { screen = Screen.SERVICE })
                    Screen.PROVIDERS -> ProvidersScreen(providerView, ::back, onCommand = { action, data -> scope.launch { command(action, payload = data) } })
                    Screen.SERVICE -> ServiceScreen(config, receiverStore.read(), captureStore, serviceEnabled(), ::back,
                        onMobileSave = { base, token ->
                            try { mobileConfigStore.save(base, token); notice = "手机连接已保存，正在验证…"; scope.launch { refresh(true) } }
                            catch (error: Exception) { notice = error.message ?: "保存失败" }
                        },
                        onReceiverSave = { base, token -> receiverStore.save(base, token); LinkSyncScheduler.syncNow(context); notice = "收藏上传配置已保存" },
                        openAccessibility = openAccessibility, exportDiagnostics = exportDiagnostics,
                        forgetMac = { mobileConfigStore.forgetMacFingerprint(); notice = "已清除 Mac 公钥信任；下次供应商操作会重新配对" })
                }
            }
            BottomBar(screen) { screen = it }
        }
    }
    deleteJob?.let { job ->
        AlertDialog(onDismissRequest = { deleteJob = null }, title = { Text("移出待处理？") },
            text = { Text("只删除这条待处理收藏，不删除已经发布的卡片。") },
            confirmButton = { TextButton(onClick = { deleteJob = null; scope.launch { command("dismiss", job.eventId) } }) { Text("移出") } },
            dismissButton = { TextButton(onClick = { deleteJob = null }) { Text("取消") } })
    }
}

@Composable
private fun BottomBar(screen: Screen, go: (Screen) -> Unit) {
    val active = when (screen) { Screen.PARSING -> Screen.PARSING; Screen.SETTINGS, Screen.PROVIDERS, Screen.SERVICE -> Screen.SETTINGS; else -> Screen.HOME }
    Row(Modifier.fillMaxWidth().background(Color(0xFFFFFEFB)).navigationBarsPadding().height(66.dp).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceAround, verticalAlignment = Alignment.CenterVertically) {
        listOf(Screen.HOME to "主题", Screen.PARSING to "收藏解析", Screen.SETTINGS to "设置").forEach { (item, title) ->
            Column(Modifier.weight(1f).clickable { go(item) }, horizontalAlignment = Alignment.CenterHorizontally) {
                val icon = when(item) { Screen.HOME -> "⌂"; Screen.PARSING -> "▣"; else -> "⚙" }
                Text(icon, color = if (active == item) forest else muted, fontSize = 21.sp)
                Text(title, color = if (active == item) forest else muted, fontSize = 12.sp)
            }
        }
    }
}

@Composable private fun PageTitle(kicker: String, title: String, subtitle: String = "", back: (() -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 22.dp)) {
        if (back != null) Text("← 返回", Modifier.clickable(onClick = back).padding(bottom = 16.dp), color = forest, fontSize = 14.sp)
        Text(kicker.uppercase(), color = forest, fontSize = 11.sp, letterSpacing = 2.sp)
        Spacer(Modifier.height(8.dp))
        Text(title, color = ink, fontFamily = serif, fontWeight = FontWeight.Bold, fontSize = 31.sp, lineHeight = 40.sp)
        if (subtitle.isNotBlank()) Text(subtitle, Modifier.padding(top = 8.dp), color = muted, fontSize = 14.sp, lineHeight = 21.sp)
    }
}

@Composable private fun EmptyMessage(message: String) {
    Text(message, Modifier.fillMaxWidth().padding(28.dp), color = muted, fontSize = 15.sp, lineHeight = 23.sp)
}

@Composable
private fun HomeScreen(catalog: Catalog, refreshing: Boolean, refreshResult: String,
                       onTopic: (String) -> Unit, onSearchSource: (String) -> Unit, onRefresh: () -> Unit) {
    var searching by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val matches = if (query.isBlank()) emptyList() else catalog.cards.filter { it.title.contains(query, true) || it.summary.contains(query, true) }.groupBy { it.sourceId }.values.map { it.first() }
    LazyVerticalGrid(columns = GridCells.Fixed(2), modifier = Modifier.fillMaxSize(),
        horizontalArrangement = Arrangement.spacedBy(5.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        item(span = { GridItemSpan(2) }) {
            Column {
                Row(Modifier.fillMaxWidth().padding(start = 26.dp, end = 26.dp, top = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("✳", color = forest, fontSize = 25.sp)
                    Text(" 拾即用", color = ink, fontFamily = serif, fontWeight = FontWeight.Bold, fontSize = 25.sp)
                    Spacer(Modifier.weight(1f))
                    Text("⌕", Modifier.clickable { searching = !searching }, color = forest, fontSize = 27.sp)
                }
                PageTitle("MY COLLECTION", "把喜欢的，\n收进自己的世界。", "${catalog.topics.size} 个主题，慢慢丰富。")
                if (searching) OutlinedTextField(query, { query = it }, label = { Text("搜索卡片") }, modifier = Modifier.fillMaxWidth().padding(horizontal = 25.dp), singleLine = true)
                TextButton(onClick = onRefresh, modifier = Modifier.padding(start = 18.dp), enabled = !refreshing) {
                    Text(if (refreshing) "正在刷新…" else "刷新收藏 ↻")
                }
                if (refreshResult.isNotBlank()) Text(refreshResult, Modifier.padding(horizontal = 26.dp), color = muted, fontSize = 12.sp)
            }
        }
        if (query.isNotBlank()) {
            if (matches.isEmpty()) item(span = { GridItemSpan(2) }) { EmptyMessage("没有找到匹配的卡片。") }
            items(matches, span = { GridItemSpan(2) }) { card -> CardPreview(card, catalog.cards.count { it.sourceId == card.sourceId }, Modifier.padding(horizontal = 25.dp, vertical = 5.dp)) { onSearchSource(card.sourceId) } }
        } else {
          if (catalog.topics.isEmpty()) item(span = { GridItemSpan(2) }) { EmptyMessage("还没有已发布的主题。收藏解析完成后，它会出现在这里；离线时会显示上次缓存。") }
          items(catalog.topics, key = { it.id }) { topic ->
            val index = catalog.topics.indexOf(topic)
            val folders = listOf(Color(0xFFE6EDD8), Color(0xFFE0ECF4), Color(0xFFF2E4D7), Color(0xFFECE3EE), Color(0xFFF2EDC9), Color(0xFFDFEEE7))
            Box(Modifier.fillMaxWidth().padding(horizontal = 5.dp).aspectRatio(1.48f).background(folders[index % folders.size], RoundedCornerShape(16.dp)).clickable { onTopic(topic.id) }) {
                Column(Modifier.align(Alignment.CenterStart).padding(start = 24.dp, end = 20.dp, top = 5.dp)) {
                    Text(topic.title, color = ink, fontFamily = serif, fontWeight = FontWeight.Bold, fontSize = 18.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text("${topic.count} 张卡片", Modifier.padding(top = 8.dp), color = muted, fontSize = 11.sp)
                }
            }
          }
        }
        item(span = { GridItemSpan(2) }) { Spacer(Modifier.height(25.dp)) }
    }
}

@Composable
private fun TopicScreen(catalog: Catalog, topicId: String, back: () -> Unit, openSource: (String) -> Unit) {
    val topic = catalog.topics.find { it.id == topicId }
    var typeFilter by remember(topicId) { mutableStateOf("") }
    val topicCards = catalog.cards.filter { topicId in it.topics }
    val types = topicCards.map { it.type }.filter(String::isNotBlank).distinct()
    val groups = topicCards.filter { typeFilter.isBlank() || it.type == typeFilter }.groupBy { it.sourceId }.values.toList()
    LazyColumn(Modifier.fillMaxSize()) {
        item { PageTitle("TOPIC / COLLECTION", topic?.title ?: "主题", "${groups.size} 个收藏 · ${groups.sumOf { it.size }} 张卡片", back) }
        if (types.size > 1) item {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 25.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                (listOf("") + types).forEach { type ->
                    val selected = typeFilter == type
                    Surface(Modifier.clickable { typeFilter = type }, shape = RoundedCornerShape(24.dp),
                        color = if (selected) Color(0xFFFFF0AF) else Color(0xFFF8F8F5), border = androidx.compose.foundation.BorderStroke(1.dp, border)) {
                        Text(if (type.isBlank()) "全部" else typeLabel(type), Modifier.padding(horizontal = 13.dp, vertical = 7.dp), color = ink, fontSize = 12.sp)
                    }
                }
            }
        }
        if (groups.isEmpty()) item { EmptyMessage("这个主题里暂时没有已发布卡片。") }
        items(groups.size) { index ->
            val cards = groups[index]
            CardPreview(cards.first(), cards.size, Modifier.padding(horizontal = 26.dp, vertical = 9.dp)) { openSource(cards.first().sourceId) }
        }
    }
}

@Composable
private fun GroupScreen(cards: List<CardItem>, back: () -> Unit, openCard: (CardItem) -> Unit) {
    LazyColumn(Modifier.fillMaxSize()) {
        item { PageTitle("FROM ONE COLLECTION", cards.firstOrNull()?.title ?: "卡片组", "${cards.size} 张卡片，来自同一收藏", back) }
        items(cards.size) { index -> CardPreview(cards[index], 1, Modifier.padding(horizontal = 26.dp, vertical = 8.dp)) { openCard(cards[index]) } }
    }
}

@Composable
private fun CardPreview(card: CardItem, groupSize: Int, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(modifier.fillMaxWidth().clickable(onClick = onClick), shape = RoundedCornerShape(13.dp), color = Color(0xFFFFFEFA), shadowElevation = 2.dp, border = androidx.compose.foundation.BorderStroke(1.dp, border)) {
        Column(Modifier.padding(18.dp)) {
            Text(if (groupSize > 1) "卡片组 · $groupSize 张" else typeLabel(card.type), color = forest, fontSize = 12.sp)
            Text(card.title, Modifier.padding(top = 6.dp), color = ink, fontFamily = serif, fontWeight = FontWeight.Bold, fontSize = 22.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (card.coverUrl.isNotBlank()) CoverImage(card.coverUrl, Modifier.fillMaxWidth().height(164.dp).padding(top = 12.dp))
            Text(card.summary, Modifier.padding(top = 12.dp), color = muted, fontSize = 14.sp, lineHeight = 21.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
            Text(if (groupSize > 1) "查看全部子卡  ↗" else "打开详情  ↗", Modifier.padding(top = 10.dp), color = forest, fontSize = 12.sp)
        }
    }
}

@Composable
private fun CoverImage(url: String, modifier: Modifier = Modifier, api: MobileApi? = null) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val imageApi = remember(api) { api ?: MobileApi(context.applicationContext) }
    var bitmap by remember(url) { mutableStateOf<android.graphics.Bitmap?>(null) }
    LaunchedEffect(url) { bitmap = withContext(Dispatchers.IO) { try { imageApi.image(url) } catch (_: Exception) { null } } }
    if (bitmap != null) Image(bitmap!!.asImageBitmap(), null, modifier.background(Color(0xFFF4F1E8)), contentScale = androidx.compose.ui.layout.ContentScale.Crop)
    else Box(modifier.background(Color(0xFFF4F1E8)), contentAlignment = Alignment.Center) { Text("图片加载中", color = muted, fontSize = 11.sp) }
}

@Composable
private fun DetailScreen(card: CardItem, api: MobileApi, context: Context, back: () -> Unit) {
    fun copy(text: String) {
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText(card.title, text))
    }
    fun open(url: String) { if (url.startsWith("https://") || url.startsWith("http://")) context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    LazyColumn(Modifier.fillMaxSize()) {
        item { PageTitle("${card.type.uppercase()} / DETAIL", card.title, "整理后的完整内容", back) }
        if (card.coverUrl.isNotBlank()) item { CoverImage(card.coverUrl, Modifier.fillMaxWidth().height(215.dp).padding(horizontal = 24.dp), api) }
        items(card.fields.size) { index ->
            val field = card.fields[index]
            Column(Modifier.fillMaxWidth().padding(horizontal = 25.dp, vertical = 10.dp)) {
                Text(field.label.ifBlank { "内容" }, color = forest, fontSize = 13.sp)
                Text(field.value, Modifier.padding(top = 7.dp), color = ink, fontSize = 15.sp, lineHeight = 25.sp)
                if (card.isPrompt && (field.label.contains("提示词") || field.label.contains("Prompt", true)))
                    OutlinedButton(onClick = { copy(field.value) }) { Text("复制提示词") }
            }
        }
        items(card.paths.size) { index ->
            val path = card.paths[index]
            Column(Modifier.fillMaxWidth().padding(horizontal = 25.dp, vertical = 10.dp)) {
                Text(path.optString("title"), color = forest, fontFamily = serif, fontSize = 18.sp)
                val steps = path.optJSONArray("steps")
                if (steps != null) for (i in 0 until steps.length()) Text("${i + 1}. ${steps.optString(i)}", Modifier.padding(top = 7.dp), color = ink, fontSize = 14.sp)
            }
        }
        items(card.actions.size) { index ->
            val action = card.actions[index]
            Row(Modifier.fillMaxWidth().padding(horizontal = 25.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (action.text.isNotBlank()) OutlinedButton(onClick = { copy(action.text) }) { Text("复制${action.label}") }
                if (action.url.isNotBlank()) OutlinedButton(onClick = { open(action.url) }) { Text(action.label.ifBlank { "打开链接" }) }
            }
        }
        items(card.imageUrls.drop(1)) { url -> CoverImage(url, Modifier.fillMaxWidth().height(250.dp).padding(horizontal = 25.dp, vertical = 6.dp), api) }
        if (card.sourceUrl.isNotBlank()) item { TextButton(onClick = { open(card.sourceUrl) }, modifier = Modifier.padding(20.dp)) { Text("打开原始来源 ↗") } }
        item { Spacer(Modifier.height(25.dp)) }
    }
}

@Composable
private fun ParsingScreen(jobs: List<JobItem>, catalog: Catalog, refreshing: Boolean, onRefresh: () -> Unit, onRetry: (String) -> Unit, onDelete: (JobItem) -> Unit) {
    val published = catalog.cards.map { it.sourceId }.toSet()
    val active = jobs.filter { job -> job.status != "published" || job.sourceId !in published }
    LazyColumn(Modifier.fillMaxSize()) {
        item { PageTitle("COLLECTION / PROCESSING", "收藏解析", "新收藏从这里开始，完成后会进入对应主题。") }
        item { TextButton(onClick = onRefresh, Modifier.padding(start = 18.dp)) { Text(if (refreshing) "正在刷新…" else "刷新状态 ↻") } }
        if (active.isEmpty()) item { EmptyMessage("暂无正在解析的收藏。复制抖音链接后，任务会先出现在这里。") }
        items(active.size) { index ->
            val job = active[index]
            Surface(Modifier.fillMaxWidth().padding(horizontal = 26.dp, vertical = 8.dp), shape = RoundedCornerShape(15.dp), color = Color.White, border = androidx.compose.foundation.BorderStroke(1.dp, border)) {
                Column(Modifier.padding(18.dp)) {
                    Text(job.title.take(80), color = ink, fontFamily = serif, fontWeight = FontWeight.Bold, fontSize = 18.sp, maxLines = 2)
                    Text(stageLabel(job), Modifier.padding(top = 12.dp), color = forest, fontSize = 13.sp)
                    Row(Modifier.fillMaxWidth().padding(top = 11.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                        listOf("接收", "抓取", "识别", "成卡").forEachIndexed { step, label ->
                            Text("${if (step < job.progressStep) "●" else if (step == job.progressStep) "◉" else "○"} $label",
                                color = if (step <= job.progressStep) forest else muted, fontSize = 11.sp)
                        }
                    }
                    Text(job.message.ifBlank { "等待下一步处理" }, Modifier.padding(top = 5.dp), color = muted, fontSize = 12.sp, lineHeight = 18.sp)
                    Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (job.status in listOf("retryable", "failed", "captured", "review_pending")) OutlinedButton(onClick = { onRetry(job.eventId) }) { Text("从失败阶段重试") }
                        if (job.status != "published") OutlinedButton(onClick = { onDelete(job) }) { Text("移出") }
                    }
                }
            }
        }
    }
}

private fun stageLabel(job: JobItem): String = when {
    job.status == "published" -> "已发布 · 等待手机同步"
    job.stage.contains("card") || job.stage.contains("candidate") -> "正在成卡"
    job.stage.contains("evidence") || job.stage.contains("asr") || job.stage.contains("ocr") -> "正在识别"
    job.status == "retryable" || job.status == "failed" -> "处理暂停 · 可重试"
    job.status == "captured" -> "抓取完成 · 等待识别"
    else -> "正在读取作品"
}

@Composable private fun SettingsScreen(connected: Boolean, accessibility: Boolean, onProviders: () -> Unit, onService: () -> Unit) {
    val context = LocalContext.current
    val versionName = remember { context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "未知" }
    LazyColumn(Modifier.fillMaxSize()) {
        item { PageTitle("拾即用 / SETTINGS", "设置", "把采集、模型和自己的卡片库连接起来。") }
        item { SettingTile("AI 供应商", "管理自己的 API、模型与切换", onProviders) }
        item { SettingTile("服务与后端", "${if (connected) "连接信息已保存" else "待配置云端"} · ${if (accessibility) "采集已开启" else "采集未开启"}", onService) }
        item { EmptyMessage("笔记规则由拾即用负责；模型供应商只负责按规则生成卡片。") }
        item { Text("拾即用 $versionName", Modifier.fillMaxWidth().padding(vertical = 18.dp), textAlign = TextAlign.Center, color = muted, fontSize = 12.sp) }
    }
}

@Composable private fun SettingTile(title: String, subtitle: String, click: () -> Unit) {
    Surface(Modifier.fillMaxWidth().padding(horizontal = 25.dp, vertical = 8.dp).clickable(onClick = click), shape = RoundedCornerShape(15.dp), color = Color.White, border = androidx.compose.foundation.BorderStroke(1.dp, border)) {
        Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, color = ink, fontFamily = serif, fontWeight = FontWeight.Bold, fontSize = 19.sp)
                Text(subtitle, Modifier.padding(top = 6.dp), color = muted, fontSize = 13.sp)
            }
            Text("→", color = forest, fontSize = 22.sp)
        }
    }
}

@Composable
private fun ProvidersScreen(view: JSONObject, back: () -> Unit, onCommand: (String, JSONObject) -> Unit) {
    val providers = remember(view.toString()) {
        val array = view.optJSONArray("providers")
        if (array == null) emptyList() else (0 until array.length()).mapNotNull { array.optJSONObject(it) }
    }
    var id by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var endpoint by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }
    var confirmDelete by remember { mutableStateOf(false) }
    fun details() = JSONObject().put("id", id.ifBlank { JSONObject.NULL }).put("name", name).put("endpoint", endpoint).put("model", model).apply { if (apiKey.isNotBlank()) put("apiKey", apiKey) }
    LazyColumn(Modifier.fillMaxSize()) {
        item { PageTitle("SETTINGS / MODEL", "AI 供应商", "切换供应商不会改动已发布的卡片。", back) }
        items(providers.size) { index ->
            val provider = providers[index]
            Surface(Modifier.fillMaxWidth().padding(horizontal = 25.dp, vertical = 6.dp), shape = RoundedCornerShape(14.dp), color = Color.White, border = androidx.compose.foundation.BorderStroke(1.dp, border)) {
                Column(Modifier.padding(15.dp)) {
                    Text(provider.optString("name") + if (provider.optString("id") == view.optString("activeProviderId")) "  · 正在使用" else "", color = ink, fontFamily = serif, fontSize = 18.sp)
                    Text(provider.optString("model"), color = muted, fontSize = 12.sp)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { id = provider.optString("id"); name = provider.optString("name"); endpoint = provider.optString("endpoint"); model = provider.optString("model"); apiKey = "" }) { Text("编辑") }
                        if (provider.optString("id") != view.optString("activeProviderId")) TextButton(onClick = { onCommand("provider_activate", JSONObject().put("id", provider.optString("id"))) }) { Text("启用") }
                    }
                }
            }
        }
        item {
            Column(Modifier.padding(horizontal = 25.dp, vertical = 18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(if (id.isBlank()) "添加供应商" else "编辑供应商", color = ink, fontFamily = serif, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                OutlinedTextField(name, { name = it }, label = { Text("供应商名称") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                OutlinedTextField(endpoint, { endpoint = it }, label = { Text("请求地址（HTTPS）") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                OutlinedTextField(model, { model = it }, label = { Text("模型 ID") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                OutlinedTextField(apiKey, { apiKey = it }, label = { Text(if (id.isBlank()) "API Key" else "新 API Key（不更换可留空）") }, modifier = Modifier.fillMaxWidth(), singleLine = true,
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation())
                Text("密钥经加密发送到配对 Mac 保存；云端不会存储明文，也不会向手机回传。Mac 离线时操作会排队，无法立即测试。", color = muted, fontSize = 12.sp, lineHeight = 18.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onCommand("provider_save", details()); apiKey = "" }, enabled = name.isNotBlank() && model.isNotBlank() && endpoint.isNotBlank()) { Text("保存") }
                    OutlinedButton(onClick = { onCommand("provider_test", if (id.isNotBlank() && apiKey.isBlank()) JSONObject().put("id", id) else details()) }) { Text("测试连接") }
                }
                if (id.isNotBlank()) TextButton(onClick = { confirmDelete = true }) { Text("删除此供应商", color = Color(0xFFA95145)) }
            }
        }
    }
    if (confirmDelete) AlertDialog(onDismissRequest = { confirmDelete = false }, title = { Text("删除供应商？") },
        confirmButton = { TextButton(onClick = { confirmDelete = false; onCommand("provider_delete", JSONObject().put("id", id)); id = "" }) { Text("删除") } },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("取消") } })
}

@Composable
private fun ServiceScreen(config: MobileConfig, receiver: ReceiverConfig, captures: CaptureStore, serviceEnabled: Boolean,
                          back: () -> Unit, onMobileSave: (String, String) -> Unit, onReceiverSave: (String, String) -> Unit,
                          openAccessibility: () -> Unit, exportDiagnostics: () -> Unit, forgetMac: () -> Unit) {
    var cloudUrl by remember(config.baseUrl) { mutableStateOf(config.baseUrl) }
    var mobileToken by remember { mutableStateOf("") }
    var intakeUrl by remember(receiver.baseUrl) { mutableStateOf(receiver.baseUrl) }
    var intakeToken by remember { mutableStateOf("") }
    LazyColumn(Modifier.fillMaxSize()) {
        item { PageTitle("SETTINGS / SERVICE", "服务与后端", "管理采集入口与自己的云端连接。", back) }
        item {
            Column(Modifier.padding(horizontal = 25.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
                Text("抖音复制链接采集", color = ink, fontFamily = serif, fontSize = 19.sp)
                Text(if (serviceEnabled) "● 已开启" else "● 未开启 · 需授权无障碍服务", color = if (serviceEnabled) forest else Color(0xFFA95145))
                OutlinedButton(onClick = openAccessibility) { Text("打开系统权限设置") }
                HorizontalDivider(color = border)
                Text("手机卡片库连接", color = ink, fontFamily = serif, fontSize = 19.sp)
                OutlinedTextField(cloudUrl, { cloudUrl = it }, label = { Text("云端 HTTPS 地址") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                OutlinedTextField(mobileToken, { mobileToken = it }, label = { Text(if (config.isComplete) "新手机凭据（不更换可留空）" else "手机专用读取/操作凭据") }, modifier = Modifier.fillMaxWidth(), singleLine = true,
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation())
                Text("手机凭据不同于收藏上传密钥。卡片和图片只对已配对手机开放。", color = muted, fontSize = 12.sp)
                Button(onClick = { onMobileSave(cloudUrl, mobileToken.ifBlank { config.token }); mobileToken = "" }, enabled = cloudUrl.isNotBlank() && (mobileToken.isNotBlank() || config.isComplete)) { Text("保存手机连接") }
                if (config.keyFingerprint.isNotBlank()) TextButton(onClick = forgetMac) { Text("Mac 换机后重新配对公钥") }
                HorizontalDivider(color = border)
                Text("收藏上传入口", color = ink, fontFamily = serif, fontSize = 19.sp)
                OutlinedTextField(intakeUrl, { intakeUrl = it }, label = { Text("接收地址") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                OutlinedTextField(intakeToken, { intakeToken = it }, label = { Text(if (receiver.isComplete) "新接收密钥（不更换可留空）" else "接收密钥") }, modifier = Modifier.fillMaxWidth(), singleLine = true,
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation())
                OutlinedButton(onClick = { onReceiverSave(intakeUrl, intakeToken.ifBlank { receiver.token }); intakeToken = "" }, enabled = intakeUrl.isNotBlank() && (intakeToken.isNotBlank() || receiver.isComplete)) { Text("保存并同步待上传收藏") }
                HorizontalDivider(color = border)
                Text("本机收藏 ${captures.savedLinks().size} 条", color = ink, fontFamily = serif, fontSize = 19.sp)
                Text("保留原有采集记录；升级界面不会清空或改写它们。", color = muted, fontSize = 12.sp)
                TextButton(onClick = exportDiagnostics) { Text("导出本机收藏与诊断") }
                Spacer(Modifier.height(25.dp))
            }
        }
    }
}
