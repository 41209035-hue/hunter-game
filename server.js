const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 取得環境變數
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
} else {
  console.error("⚠️ 警告：未讀取到 Supabase 環境變數！");
}

// CP 與對應密碼表
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

// 寫入日誌記錄（安全靜默處理，不擋住主要邏輯）
async function logAction(groupId, targetId, stage, note) {
  if (!supabase) return;
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
    console.error("Log error (ignored):", err.message);
  }
}

// API 1: 綁定目標與獲取初始謎題
app.post('/api/bind-target', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ success: false, message: "伺服器資料庫連線尚未設定完成 (缺少環境變數)！" });
    }

    const { groupId, targetId } = req.body;
    const targetIndex = parseInt(targetId, 10);

    if (!groupId || isNaN(targetIndex)) {
      return res.json({ success: false, message: "請選擇正確的組別與通緝犯代碼！" });
    }

    // 1. 查詢目標人物資料 (target_data)
    const { data: targetData, error: targetError } = await supabase
      .from('target_data')
      .select('*')
      .eq('id', targetIndex)
      .maybeSingle();

    if (targetError) {
      console.error("target_data 查詢失敗:", targetError);
      return res.json({ success: false, message: `資料庫查詢錯誤: ${targetError.message}` });
    }

    if (!targetData) {
      return res.json({ success: false, message: "查無此通緝犯代碼，請確認編號後重新輸入！" });
    }

    // 2. 查詢小組路線資料 (route_data)
    const { data: routeData, error: routeError } = await supabase
      .from('route_data')
      .select('*')
      .eq('group_id', groupId.toUpperCase())
      .maybeSingle();

    if (routeError) {
      console.error("route_data 查詢失敗:", routeError);
      return res.json({ success: false, message: `小組路線查詢錯誤: ${routeError.message}` });
    }

    if (!routeData) {
      return res.json({ success: false, message: "查無此小組編號！" });
    }

    // 處理路線與謎題陣列
    const routeList = typeof routeData.route === 'string' 
      ? routeData.route.split(',').map(s => s.trim()) 
      : (routeData.route || []);

    const puzzles = [
      routeData.r1_puzzle || "", routeData.r2_puzzle || "", routeData.r3_puzzle || "",
      routeData.r4_puzzle || "", routeData.r5_puzzle || "", routeData.r6_puzzle || ""
    ];

    const targetInfo = {
      code: String(targetId),
      itemPhoto: convertDriveUrlToDirect(targetData.belongings_img_url),
      itemDesc: targetData.belongings_desc || "無證物描述"
    };

    // 紀錄寫入 log
    logAction(groupId, targetId, 0, "BINDING");

    return res.json({
      success: true,
      targetInfo,
      route: routeList,
      puzzles
    });
  } catch (err) {
    console.error("Unhandled error in bind-target:", err);
    return res.status(500).json({ success: false, message: `伺服器內部錯誤: ${err.message}` });
  }
});

// API 2: 提交密碼驗證並獲取下一階段線索
app.post('/api/submit-passcode', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ success: false, message: "伺服器資料庫連線尚未設定完成！" });
    }

    const { groupId, targetId, currentStage, inputPasscode, route, puzzles } = req.body;

    const expectedCP = route ? route[currentStage] : "";
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
      .maybeSingle();

    if (targetError || !targetData) {
      return res.json({ success: false, message: "找不到該通緝犯資料！" });
    }

    let unlockedHint = "";
    let finalName = "";
    let finalPhoto = "";

    if (nextStage === 1) {
      unlockedHint = targetData.message_to_mentees || "無通緝宣言";
    } else if (nextStage === 2) {
      unlockedHint = targetData.favorite_drink || "無最愛手搖飲紀錄";
    } else if (nextStage === 3) {
      unlockedHint = targetData.catchphrase || "無口頭禪紀錄";
    } else if (nextStage === 4) {
      unlockedHint = targetData.interests || "無日常喜好紀錄";
    } else if (nextStage === 5) {
      const rawId = String(targetData.student_id || "").trim();
      if (rawId.length >= 2) {
        const digit1 = parseInt(rawId.charAt(rawId.length - 2), 10) || 0;
        const digit2 = parseInt(rawId.charAt(rawId.length - 1), 10) || 0;
        unlockedHint = `學號末兩碼數字加總結果為：【 ${digit1 + digit2} 】`;
      } else {
        unlockedHint = `學號末數字加總提示：${rawId}`;
      }
    } else if (nextStage === 6) {
      finalName = targetData.name || "未知直屬";
      finalPhoto = convertDriveUrlToDirect(targetData.avatar_img_url);
    }

    logAction(groupId, targetId, nextStage, inputPasscode);

    return res.json({
      success: true,
      nextStage,
      isFinished,
      unlockedHint,
      finalName,
      finalPhoto,
      nextCP: isFinished ? null : (route ? route[nextStage] : null),
      nextPuzzle: isFinished ? null : (puzzles ? puzzles[nextStage] : null)
    });
  } catch (err) {
    console.error("Unhandled error in submit-passcode:", err);
    return res.status(500).json({ success: false, message: `伺服器內部錯誤: ${err.message}` });
  }
});

// 本地開發時才監聽 Port，部署到 Vercel 時匯出 app 即可
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running locally on port ${PORT}`);
  });
}

module.exports = app;