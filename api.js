// api.js
import axios from 'axios';

export const studentInfo = async (spid, tkn) => {
    try {
        const response = await axios({
            method: 'POST',
            url: `http://localhost:8383/api/v1/vle/student/get-login/${spid}`,
            headers: {
                Authorization: "Bearer " + tkn
            }
        });

        const data = response.data.data;
        const userToken = "Bearer " + response.data.message;

        return {
            success: true,
            data,
            userToken,
            wsToken: data.wsToken
        };
    } catch (error) {
        console.error("studentInfo error:", error);
        return {success: false, error: error.message};
    }
};
