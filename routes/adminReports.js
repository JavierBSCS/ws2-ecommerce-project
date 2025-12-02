// routes/adminReports.js
const express = require("express");
const router = express.Router();
const isAdmin = require("../middleware/isAdmin");

// GET /admin/reports/sales – sales overview with filters and aggregation
router.get("/reports/sales", isAdmin, async (req, res) => {
  try {
    console.log("🔍 ===== SALES REPORT START =====");
    
    const db = req.app.locals.client.db(req.app.locals.dbName);
    const ordersCollection = db.collection("orders");

    // 1. Read filters from query string
    const startDateRaw = (req.query.startDate || "").trim();
    const endDateRaw = (req.query.endDate || "").trim();
    const statusRaw = (req.query.status || "all").trim();

    const filters = {
      startDate: startDateRaw,
      endDate: endDateRaw,
      status: statusRaw || "all"
    };

    console.log("📋 Filters received:", JSON.stringify(filters, null, 2));

    // 2. Build match stage for aggregation
    const matchStage = {};
    
    // Date range filter
    const createdAtFilter = {};
    if (startDateRaw) {
      const startDateObj = new Date(startDateRaw);
      if (!isNaN(startDateObj.getTime())) {
        createdAtFilter.$gte = startDateObj;
      }
    }
    
    if (endDateRaw) {
      const endDateObj = new Date(endDateRaw);
      if (!isNaN(endDateObj.getTime())) {
        endDateObj.setHours(23, 59, 59, 999);
        createdAtFilter.$lte = endDateObj;
      }
    }
    
    if (Object.keys(createdAtFilter).length > 0) {
      matchStage.createdAt = createdAtFilter;
      console.log("📅 Date filter:", createdAtFilter);
    }
    
    // Status filter (optional)
    if (filters.status !== "all") {
      matchStage.orderStatus = filters.status;
      console.log("🏷️ Status filter:", filters.status);
    }

    console.log("🎯 Final match stage:", JSON.stringify(matchStage, null, 2));

    // 3. Build aggregation pipeline for daily sales
    const pipeline = [];
    
    if (Object.keys(matchStage).length > 0) {
      pipeline.push({ $match: matchStage });
    }
    
    pipeline.push(
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            day: { $dayOfMonth: "$createdAt" }
          },
          totalSales: { $sum: "$totalAmount" },
          orderCount: { $sum: 1 }
        }
      },
      {
        $sort: {
          "_id.year": 1,
          "_id.month": 1,
          "_id.day": 1
        }
      }
    );

    // 4. Run aggregation for daily sales
    const aggregationResult = await ordersCollection.aggregate(pipeline).toArray();
    console.log(`📈 Aggregation found ${aggregationResult.length} days of data`);

    // 5. Convert to dailySales array
    const dailySales = aggregationResult.map(doc => {
      const year = doc._id.year;
      const month = String(doc._id.month).padStart(2, "0");
      const day = String(doc._id.day).padStart(2, "0");

      return {
        date: `${year}-${month}-${day}`,
        totalSales: doc.totalSales || 0,
        orderCount: doc.orderCount || 0
      };
    });

    // 6. Compute summary values
    let totalSalesAll = 0;
    let totalOrdersAll = 0;

    dailySales.forEach(day => {
      totalSalesAll += Number(day.totalSales) || 0;
      totalOrdersAll += Number(day.orderCount) || 0;
    });

    const averageOrderValue = totalOrdersAll > 0 ? totalSalesAll / totalOrdersAll : 0;

    const summary = {
      totalSales: totalSalesAll,
      totalOrders: totalOrdersAll,
      averageOrderValue
    };

    console.log("💰 Summary:", {
      totalSales: summary.totalSales,
      totalOrders: summary.totalOrders,
      averageOrderValue: summary.averageOrderValue
    });

    // 7. Prepare chart data
    const labels = dailySales.map(day => day.date);
    const salesData = dailySales.map(day => Number(day.totalSales) || 0);

    // 8. Get status distribution for pie chart
    const statusDistribution = await ordersCollection.aggregate([
      {
        $match: matchStage // Use the same matchStage as your main query
      },
      {
        $group: {
          _id: "$orderStatus",
          count: { $sum: 1 }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]).toArray();

    console.log("📊 Status Distribution:", statusDistribution);

    // 9. Get total order count for each status (for unfiltered view)
    let allStatusDistribution = [];
    if (filters.status === "all") {
      // Get all statuses count without date filter
      const allStatusMatch = {};
      if (Object.keys(createdAtFilter).length > 0) {
        allStatusMatch.createdAt = createdAtFilter; // Keep date filter if applied
      }
      
      allStatusDistribution = await ordersCollection.aggregate([
        {
          $match: allStatusMatch
        },
        {
          $group: {
            _id: "$orderStatus",
            count: { $sum: 1 }
          }
        },
        {
          $sort: { count: -1 }
        }
      ]).toArray();
      
      console.log("📊 All Status Distribution:", allStatusDistribution);
    }

    console.log("✅ ===== SALES REPORT END =====");

    // 10. Render view with all data
    res.render("admin/admin-reports-sales", {
      title: "Admin – Sales Overview",
      filters,
      dailySales,
      summary,
      labels,
      salesData,
      statusDistribution: filters.status === "all" ? allStatusDistribution : statusDistribution
    });
    
  } catch (err) {
    console.error("❌ Error loading sales report:", err);
    res.status(500).send("Error loading sales report.");
  }
});

module.exports = router;