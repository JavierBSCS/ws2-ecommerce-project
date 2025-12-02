// routes/adminReports.js
const express = require("express");
const router = express.Router();
const isAdmin = require("../middleware/isAdmin");
const XLSX = require('xlsx'); // Make sure you have this installed: npm install xlsx

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

// ============================================================================
// GET /admin/reports/sales/export/orders - Detailed orders Excel export (FIXED)
// ============================================================================
router.get("/reports/sales/export/orders", isAdmin, async (req, res) => {
    console.log("📤 ===== EXPORT START =====");
    console.log("📋 Query params:", req.query);
    
    try {
        const db = req.app.locals.client.db(req.app.locals.dbName);
        const ordersCollection = db.collection("orders");
        const usersCollection = db.collection("users");
        
        // Read filters from query
        const startDateRaw = (req.query.startDate || "").trim();
        const endDateRaw = (req.query.endDate || "").trim();
        const statusRaw = (req.query.status || "all").trim();
        
        // Build MongoDB query
        const query = {};
        
        // Date range filter
        const dateFilter = {};
        if (startDateRaw) {
            const startDate = new Date(startDateRaw);
            if (!isNaN(startDate.getTime())) {
                startDate.setHours(0, 0, 0, 0);
                dateFilter.$gte = startDate;
                console.log("📅 Export start date:", startDate);
            }
        }
        
        if (endDateRaw) {
            const endDate = new Date(endDateRaw);
            if (!isNaN(endDate.getTime())) {
                endDate.setHours(23, 59, 59, 999);
                dateFilter.$lte = endDate;
                console.log("📅 Export end date:", endDate);
            }
        }
        
        if (Object.keys(dateFilter).length > 0) {
            query.createdAt = dateFilter;
        }
        
        // Status filter
        if (statusRaw !== "all") {
            query.orderStatus = statusRaw;
        }
        
        console.log("🔍 Export query:", JSON.stringify(query, null, 2));
        
        // Fetch orders with all details
        console.log("📥 Fetching orders from database...");
        const orders = await ordersCollection.find(query)
            .sort({ createdAt: -1 })
            .toArray();
        
        console.log(`✅ Found ${orders.length} orders for export`);
        
        if (orders.length === 0) {
            console.log("⚠️ No orders found - returning 404");
            return res.status(404).send("No orders found with the selected filters.");
        }
        
        // Get all user IDs from orders to fetch user details
        const userIds = [...new Set(orders.map(order => order.userId).filter(id => id))];
        console.log("👥 User IDs to fetch:", userIds);
        
        // Fetch user details
        const users = await usersCollection.find({ 
            userId: { $in: userIds } 
        }).toArray();
        
        // Create a map for quick user lookup
        const userMap = {};
        users.forEach(user => {
            userMap[user.userId] = {
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                address: user.address || '',
                city: user.city || '',
                province: user.province || '',
                zip: user.zip || '',
                phone: user.phone || ''
            };
        });
        
        console.log(`📧 Fetched ${users.length} user records`);
        
        // Create workbook
        console.log("📊 Creating Excel workbook...");
        const wb = XLSX.utils.book_new();
        
        // Prepare detailed data - ONLY the required columns from your requirements
        console.log("📝 Preparing detailed data for Excel...");
        const ordersData = [
            // Only these columns as per requirements
            ['Order ID', 'Date/Time', 'User ID', 'User Email', 'Status', 'Total Amount']
        ];
        
        orders.forEach(order => {
            const user = userMap[order.userId] || {};
            
            ordersData.push([
                order.orderId || order._id.toString(),
                order.createdAt ? new Date(order.createdAt).toLocaleString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                }) : '',
                order.userId || '',
                user.email || '', // Get email from users collection
                order.orderStatus || '',
                `₱${Number(order.totalAmount || 0).toFixed(2)}`
                // Removed Items Count, Customer Name, Shipping Address as per requirements
            ]);
        });
        
        console.log(`📋 Prepared ${ordersData.length - 1} rows of data`);
        
        // Add main sheet
        console.log("📑 Adding worksheet...");
        const ws = XLSX.utils.aoa_to_sheet(ordersData);
        XLSX.utils.book_append_sheet(wb, ws, 'Detailed Orders');
        
        // Format columns (only for the required columns)
        console.log("📐 Formatting columns...");
        const wscols = [
            { wch: 20 }, // Order ID
            { wch: 20 }, // Date/Time
            { wch: 15 }, // User ID
            { wch: 25 }, // User Email
            { wch: 12 }, // Status
            { wch: 15 }  // Total Amount
        ];
        ws['!cols'] = wscols;
        
        // Set response headers
        console.log("📤 Setting response headers...");
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="detailed_orders_${new Date().toISOString().split('T')[0]}.xlsx"`);
        
        // Generate Excel buffer
        console.log("⚙️ Generating Excel buffer...");
        const buffer = XLSX.write(wb, { 
            type: 'buffer', 
            bookType: 'xlsx' 
        });
        
        console.log(`✅ Excel buffer generated: ${buffer.length} bytes`);
        
        // Send the buffer
        res.end(buffer);
        console.log("📤 ===== EXPORT COMPLETE =====");
        
    } catch (error) {
        console.error('❌ Error exporting detailed orders:', error);
        console.error('❌ Error stack:', error.stack);
        
        // Only send error if headers haven't been sent yet
        if (!res.headersSent) {
            res.status(500).send('Error exporting detailed orders Excel file.');
        } else {
            console.error('❌ Headers already sent, cannot send error response');
        }
    }
});

module.exports = router;