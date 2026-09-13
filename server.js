const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors()); // 允許前端跨域請求
app.use(express.json());

// 使用 service_role 初始化 Supabase，確保後端可以讀寫資料庫
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// CP 與對應密碼表 (保留在後端，前端無法查閱)
const CP_PASSCODES = {
  "CP1": "游刃有餘",
  "CP2": "霹靂卡霹靂拉拉波波莉娜貝貝魯多",
  "CP3": "3305",
  "CP4": "阿公甲龜記",
  "CP5": "小妹你別慌",
  "CP6": "歡樂一百點"
};

// 將 Google Drive 分享網址轉為直接顯示圖片的網址
function convertDriveUrlToDirect(url) {
  if (!url) return "";
  const match = String(url).match(/id=([a-zA-Z0-9_-]+)/) || String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return "https://lh3.googleusercontent.com/d/" + match[1];
  }
  return url;
}

// 寫入日誌記錄
async function logAction(groupId, targetId, stage, note) {
  try {
    await supabase.from('system_log').insert([
      {
        logged_at: new Date().toISOString(),
        group_id: groupId,
        user_id: String(targetId),
        step_code: stage,
        action_or_answer: note
      }
    ]);
  } catch (err) {
    console.error("Log error:", err);
  }
}

// API 1: 綁定目標與獲取初始謎題
app.post('/api/bind-target', async (req, res) => {
  try {
    const { groupId, targetId } = req.body;
    const targetIndex = parseInt(targetId, 10);

    if (isNaN(targetIndex)) {
      return res.json({ success: false, message: "無效的通緝犯代碼！" });
    }

    // 1. 查詢目標人物資料 (target_data)
    const { data: targetData, error: targetError } = await supabase
      .from('target_data')
      .select('*')
      .eq('id', targetIndex)
      .single();

    if (targetError || !targetData) {
      return res.json({ success: false, message: "查無此通緝犯代碼，請確認編號後重新輸入！" });
    }

    // 2. 查詢小組路線資料 (route_data)
    const { data: routeData, error: routeError } = await supabase
      .from('route_data')
      .select('*')
      .eq('group_id', groupId.toUpperCase())
      .single();

    if (routeError || !routeData) {
      return res.json({ success: false, message: "查無此小組編號！" });
    }

    // 處理路線與謎題陣列
    const routeList = typeof routeData.route === 'string' 
      ? routeData.route.split(',').map(s => s.trim()) 
      : routeData.route;

    const puzzles = [
      routeData.r1_puzzle, routeData.r2_puzzle, routeData.r3_puzzle,
      routeData.r4_puzzle, routeData.r5_puzzle, routeData.r6_puzzle
    ];

    const targetInfo = {
      code: String(targetId),
      itemPhoto: convertDriveUrlToDirect(targetData.belongings_img_url || targetData.item_photo),
      itemDesc: targetData.belongings_desc || targetData.item_desc
    };

    // 紀錄寫入 log
    await logAction(groupId, targetId, 0, "BINDING");

    return res.json({
      success: true,
      targetInfo,
      route: routeList,
      puzzles
    });
  } catch (err) {
    return res.json({ success: false, message: err.toString() });
  }
});

// API 2: 提交密碼驗證並獲取下一階段線索
app.post('/api/submit-passcode', async (req, res) => {
  try {
    const { groupId, targetId, currentStage, inputPasscode, route, puzzles } = req.body;

    const expectedCP = route[currentStage];
    const correctPasscode = CP_PASSCODES[expectedCP];

    if (!inputPasscode || inputPasscode.trim() !== correctPasscode) {
      return res.json({ success: false, message: "密碼錯誤！請向線人關主確認密碼。" });
    }

    const nextStage = currentStage + 1;
    const isFinished = nextStage >= 6;

    // 讀取該通緝犯資料
    const { data: targetData, error: targetError } = await supabase
      .from('target_data')
      .select('*')
      .eq('id', parseInt(targetId, 10))
      .single();

    if (targetError || !targetData) {
      return res.json({ success: false, message: "找不到該通緝犯資料！" });
    }

    let unlockedHint = "";
    let finalName = "";
    let finalPhoto = "";

    // 根據關卡發放對應線索 (維持原本 GAS 的邏輯)
    if (nextStage === 1) {
      unlockedHint = targetData.message_to_mentees || targetData.h_hint || "無通緝宣言";
    } else if (nextStage === 2) {
      unlockedHint = targetData.favorite_drink || targetData.i_hint || "無最愛手搖飲紀錄";
    } else if (nextStage === 3) {
      unlockedHint = targetData.catchphrase || targetData.j_hint || "無口頭禪紀錄";
    } else if (nextStage === 4) {
      unlockedHint = targetData.interests || targetData.k_hint || "無日常喜好紀錄";
    } else if (nextStage === 5) {
      // 第 5 關邏輯：學號末兩碼加總
      const rawId = String(targetData.student_id || targetData.b_column || "").trim();
      if (rawId.length >= 2) {
        const digit1 = parseInt(rawId.charAt(rawId.length - 2), 10) || 0;
        const digit2 = parseInt(rawId.charAt(rawId.length - 1), 10) || 0;
        unlockedHint = `學號末兩碼數字加總結果為：【 ${digit1 + digit2} 】`;
      } else {
        unlockedHint = `學號末數字加總提示：${rawId}`;
      }
    } else if (nextStage === 6) {
      // 最終關：揭曉真實姓名與照片
      finalName = targetData.name || targetData.c_column;
      finalPhoto = convertDriveUrlToDirect(targetData.avatar_img_url || targetData.l_column);
    }

    await logAction(groupId, targetId, nextStage, inputPasscode);

    return res.json({
      success: true,
      nextStage,
      isFinished,
      unlockedHint,
      finalName,
      finalPhoto,
      nextCP: isFinished ? null : route[nextStage],
      nextPuzzle: isFinished ? null : puzzles[nextStage]
    });
  } catch (err) {
    return res.json({ success: false, message: err.toString() });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});